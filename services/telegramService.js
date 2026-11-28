import axios from 'axios'
import mongoose from 'mongoose'
import User from '../models/User.js'
import { getOrCreateCrmSettings, DEFAULT_TELEGRAM_TEMPLATES } from '../models/CrmSettings.js'

const EVENT_TO_USER_PREF = {
  newLead: 'newLead',
  leadAssigned: 'leadAssigned',
  discountRequested: 'discountRequested',
  discountApproved: 'discountDecision',
  discountRejected: 'discountDecision',
  businessMilestone: 'businessMilestone',
}

export const TELEGRAM_EVENT_META = [
  {
    key: 'newLead',
    label: 'New Lead Captured',
    audience: 'Admins (Telegram-enabled)',
    placeholders: ['leadName', 'phone', 'course', 'source', 'assignedTo'],
  },
  {
    key: 'leadAssigned',
    label: 'Lead Assigned / Auto-Assigned',
    audience: 'Assigned Sales Counselor',
    placeholders: ['leadName', 'phone', 'course', 'assignedBy', 'count'],
  },
  {
    key: 'discountRequested',
    label: 'Discount Approval Requested',
    audience: 'Admins (Telegram-enabled)',
    placeholders: ['leadName', 'phone', 'course', 'standardFee', 'agreedAmount', 'discountAmount', 'reason', 'requestedBy'],
  },
  {
    key: 'discountApproved',
    label: 'Discount Approved by Admin',
    audience: 'Requesting Counselor',
    placeholders: ['leadName', 'phone', 'targetStatus', 'agreedAmount', 'discountAmount', 'decidedBy', 'remarks'],
  },
  {
    key: 'discountRejected',
    label: 'Discount Rejected by Admin',
    audience: 'Requesting Counselor',
    placeholders: ['leadName', 'phone', 'agreedAmount', 'decidedBy', 'remarks'],
  },
  {
    key: 'businessMilestone',
    label: 'Business Milestone Reached',
    audience: 'Admins (Telegram-enabled)',
    placeholders: ['status', 'leadName', 'phone', 'course', 'agreedAmount', 'paidAmount', 'assignedTo'],
  },
]

export function getTelegramBotToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || process.env.telegram || '').trim()
}

let cachedBotInfo = null
let cachedBotFetchedAt = 0

export async function getTelegramBotStatus() {
  const token = getTelegramBotToken()
  if (!token) {
    return { configured: false, botUsername: '', botName: '' }
  }
  // Cache /getMe result for 10 minutes to avoid unnecessary API hits
  if (cachedBotInfo && Date.now() - cachedBotFetchedAt < 10 * 60 * 1000) {
    return cachedBotInfo
  }
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 6000 })
    if (res.data?.ok && res.data?.result) {
      cachedBotInfo = {
        configured: true,
        botUsername: res.data.result.username ? `@${res.data.result.username}` : '',
        botName: res.data.result.first_name || 'CRM Notification Bot',
      }
      cachedBotFetchedAt = Date.now()
      return cachedBotInfo
    }
  } catch (err) {
    console.warn('[Telegram] getMe check failed:', err.response?.data?.description || err.message)
  }
  return { configured: true, botUsername: '', botName: 'Telegram Bot (.env configured)' }
}

export function renderTelegramTemplate(templateStr, variables = {}) {
  const base = String(templateStr || '').trim()
  if (!base) return ''
  return base.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = variables[key]
    if (val === undefined || val === null || val === '') return '—'
    return String(val)
  })
}

export async function sendTelegramMessage(chatId, text) {
  const token = getTelegramBotToken()
  const cleanChatId = String(chatId || '').trim()
  if (!token) {
    return { ok: false, error: 'Telegram bot token is not configured in server .env.' }
  }
  if (!cleanChatId) {
    return { ok: false, error: 'Telegram Chat ID is required.' }
  }
  if (!text || !String(text).trim()) {
    return { ok: false, error: 'Message text is empty.' }
  }

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: cleanChatId,
        text: String(text),
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    )
    if (res.data && res.data.ok) {
      return { ok: true }
    }
    return { ok: false, error: res.data?.description || 'Telegram API rejected the message.' }
  } catch (err) {
    const errMsg = err.response?.data?.description || err.message
    console.warn(`[Telegram] Failed sending to ${cleanChatId}:`, errMsg)
    return { ok: false, error: errMsg }
  }
}

export function formatMoneyIN(num) {
  const n = Number(num)
  if (Number.isNaN(n)) return '0'
  return n.toLocaleString('en-IN')
}

/**
 * Dispatches a customizable Telegram notification event to eligible users.
 * Never throws so core CRM workflows are never blocked by network issues.
 *
 * @param {string} eventKey - One of newLead, leadAssigned, discountRequested, discountApproved, discountRejected, businessMilestone
 * @param {object} variables - Key-value placeholders interpolated into the template
 * @param {object} options - { notifyAdmins?: boolean, targetUserIds?: string[], overrideText?: string }
 */
export async function notifyTelegramEvent(eventKey, variables = {}, options = {}) {
  try {
    const token = getTelegramBotToken()
    if (!token) return { sent: 0, skipped: true }

    const settings = await getOrCreateCrmSettings()
    const tg = settings.telegramSettings || {}
    if (tg.enabled === false) return { sent: 0, skipped: true }
    if (tg.events && tg.events[eventKey] === false) return { sent: 0, skipped: true }

    const template =
      options.overrideText ||
      (tg.templates && tg.templates[eventKey]) ||
      DEFAULT_TELEGRAM_TEMPLATES[eventKey] ||
      ''
    const messageText = renderTelegramTemplate(template, variables)
    if (!messageText) return { sent: 0, skipped: true }

    const prefKey = EVENT_TO_USER_PREF[eventKey] || eventKey
    const orFilters = []

    if (options.notifyAdmins) {
      orFilters.push({ role: 'admin' })
    }

    const rawIds = Array.isArray(options.targetUserIds) ? options.targetUserIds : []
    const validObjIds = rawIds
      .map(id => String(id || '').trim())
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id))

    if (validObjIds.length > 0) {
      orFilters.push({ _id: { $in: validObjIds } })
    }

    if (orFilters.length === 0) return { sent: 0, skipped: true }

    const recipients = await User.find({
      active: { $ne: false },
      telegramNotificationsEnabled: true,
      telegramChatId: { $exists: true, $ne: '' },
      $or: orFilters,
    })
      .select('name role telegramChatId telegramPreferences')
      .lean()

    const uniqueChatIds = new Set()
    for (const u of recipients) {
      const chatId = String(u.telegramChatId || '').trim()
      if (!chatId) continue
      const prefs = u.telegramPreferences || {}
      if (prefs[prefKey] === false) continue
      uniqueChatIds.add(chatId)
    }

    if (uniqueChatIds.size === 0) return { sent: 0 }

    const results = await Promise.allSettled(
      Array.from(uniqueChatIds).map(chatId => sendTelegramMessage(chatId, messageText))
    )

    const sent = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length
    return { sent, total: uniqueChatIds.size }
  } catch (err) {
    console.warn(`[Telegram] notifyTelegramEvent(${eventKey}) error:`, err.message)
    return { sent: 0, error: err.message }
  }
}

export async function sendTestTelegramAlert({ chatId, eventKey = 'newLead', customTemplate = '' }) {
  const sampleVars = {
    leadName: 'Aarav Nair (Sample Lead)',
    phone: '+91 98765 43210',
    course: 'Healthcare Management (6 Month)',
    source: 'Meta Lead Ads',
    assignedTo: 'Priya Sharma',
    assignedBy: 'Administrator',
    count: '1',
    standardFee: '1,00,000',
    agreedAmount: '90,000',
    discountAmount: '10,000',
    reason: 'Merit Scholarship',
    requestedBy: 'Priya Sharma',
    targetStatus: 'CONVERTED BUSINESS',
    decidedBy: 'Administrator',
    remarks: 'Approved for May intake',
    status: 'CONVERTED BUSINESS',
    paidAmount: '25,000',
  }

  let text = ''
  if (customTemplate && String(customTemplate).trim()) {
    text = `[TEST ALERT]\n${renderTelegramTemplate(customTemplate, sampleVars)}`
  } else {
    const settings = await getOrCreateCrmSettings()
    const tpl =
      settings.telegramSettings?.templates?.[eventKey] ||
      DEFAULT_TELEGRAM_TEMPLATES[eventKey] ||
      'Futureace Academy CRM: Telegram notifications are connected and active!'
    text = `[TEST ALERT]\n${renderTelegramTemplate(tpl, sampleVars)}`
  }

  return sendTelegramMessage(chatId, text)
}
