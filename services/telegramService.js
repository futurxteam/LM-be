import axios from 'axios'
import crypto from 'crypto'
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
    const rawMsg = err.response?.data?.description || err.message
    let friendlyMsg = rawMsg
    if (/chat not found/i.test(rawMsg)) {
      friendlyMsg = `${rawMsg} — Verify the numeric Chat ID and ensure the user has opened the bot on Telegram and tapped Start (/start).`
    } else if (/bot was blocked by the user/i.test(rawMsg)) {
      friendlyMsg = `${rawMsg} — The user blocked the bot on Telegram and must unblock it and send /start.`
    } else if (/unauthorized/i.test(rawMsg)) {
      friendlyMsg = `${rawMsg} — Check TELEGRAM_BOT_TOKEN in server environment variables.`
    }
    console.warn(`[Telegram] Failed sending to ${cleanChatId}:`, rawMsg)
    return { ok: false, error: friendlyMsg }
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

/**
 * Fetches recent chats that have messaged / pressed /start on the configured Telegram bot.
 * Lets Admins pick a user's numeric Chat ID directly inside the CRM UI.
 */
export async function getRecentTelegramChats() {
  const token = getTelegramBotToken()
  if (!token) {
    return {
      ok: false,
      error: 'Telegram bot token is not configured in server .env.',
      chats: [],
      botUsername: '',
    }
  }

  try {
    const [botStatus, updatesRes] = await Promise.all([
      getTelegramBotStatus(),
      axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
        params: { limit: 100 },
        timeout: 8000,
      }),
    ])

    if (!updatesRes.data?.ok) {
      return {
        ok: false,
        error: updatesRes.data?.description || 'Failed to read updates from Telegram bot.',
        chats: [],
        botUsername: botStatus.botUsername || '',
      }
    }

    const updates = Array.isArray(updatesRes.data.result) ? updatesRes.data.result : []
    const chatMap = new Map()

    for (const upd of updates) {
      // Also auto-complete any pending `/start link_<token>` deep-links found while fetching chats
      await processSingleTelegramUpdate(upd)

      const msg =
        upd.message ||
        upd.edited_message ||
        upd.channel_post ||
        upd.my_chat_member ||
        upd.callback_query?.message
      const chat = msg?.chat
      if (!chat || chat.id === undefined || chat.id === null) continue

      const chatId = String(chat.id)
      const first = chat.first_name || msg?.from?.first_name || ''
      const last = chat.last_name || msg?.from?.last_name || ''
      const fullName = [first, last].filter(Boolean).join(' ').trim()
      const displayName = chat.title || fullName || (chat.username ? `@${chat.username}` : `Chat ${chatId}`)
      const username = chat.username ? `@${chat.username}` : (msg?.from?.username ? `@${msg.from.username}` : '')
      const lastAt = msg?.date ? new Date(msg.date * 1000).toISOString() : null
      const lastText = typeof msg?.text === 'string' ? msg.text.slice(0, 60) : ''

      const existing = chatMap.get(chatId)
      if (!existing || (lastAt && (!existing.lastAt || lastAt > existing.lastAt))) {
        chatMap.set(chatId, {
          chatId,
          displayName,
          username,
          type: chat.type || 'private',
          lastText,
          lastAt,
        })
      }
    }

    const chats = Array.from(chatMap.values()).sort((a, b) =>
      String(b.lastAt || '').localeCompare(String(a.lastAt || ''))
    )

    return {
      ok: true,
      botUsername: botStatus.botUsername || '',
      chats,
    }
  } catch (err) {
    const rawMsg = err.response?.data?.description || err.message
    let friendlyMsg = rawMsg
    if (/webhook/i.test(rawMsg)) {
      friendlyMsg = `${rawMsg} — A Telegram webhook is active on this bot, which blocks getUpdates. Delete the webhook or use @userinfobot to get Chat IDs.`
    }
    return {
      ok: false,
      error: friendlyMsg,
      chats: [],
      botUsername: '',
    }
  }
}

/**
 * Generates (or reuses) a unique Telegram deep-link URL for a CRM user.
 * When the user opens the link and taps Start, Telegram sends `/start link_<token>`
 * to the bot, allowing our backend to identify their CRM account and save their Chat ID.
 */
export async function generateUserTelegramConnectLink(userId) {
  const token = getTelegramBotToken()
  if (!token) {
    return {
      ok: false,
      error: 'Telegram bot token is not configured on the server.',
    }
  }

  const user = await User.findById(userId)
  if (!user) {
    return { ok: false, error: 'User account not found.' }
  }

  const botStatus = await getTelegramBotStatus()
  const cleanHandle = (
    botStatus.botUsername ||
    process.env.TELEGRAM_BOT_USERNAME ||
    'Futureace_crm_Bot'
  )
    .replace(/^@/, '')
    .trim()

  if (!user.telegramLinkToken) {
    user.telegramLinkToken = crypto.randomBytes(12).toString('hex')
    await user.save()
  }

  const connectUrl = `https://t.me/${cleanHandle}?start=link_${user.telegramLinkToken}`
  // Start a short-lived temporary poller ONLY while waiting for this link (auto-stops when linked or after 3 min)
  scheduleTemporaryLinkPoll(3 * 60 * 1000)
  return {
    ok: true,
    connectUrl,
    botUsername: `@${cleanHandle}`,
    alreadyLinked: Boolean(String(user.telegramChatId || '').trim()),
  }
}

/**
 * Processes a single Telegram Update object to detect `/start link_<token>` deep-links
 * and automatically save the user's Telegram Chat ID in MongoDB.
 */
export async function processSingleTelegramUpdate(upd) {
  try {
    const msg = upd?.message || upd?.edited_message
    const text = typeof msg?.text === 'string' ? msg.text.trim() : ''
    const chatId = msg?.chat?.id !== undefined && msg?.chat?.id !== null ? String(msg.chat.id) : ''
    if (!text || !chatId) return { linked: false }

    const match = text.match(/^\/start(?:@\w+)?\s+link_([a-f0-9]{8,64})$/i)
    if (!match) return { linked: false }

    const linkToken = match[1].toLowerCase()
    const user = await User.findOne({ telegramLinkToken: linkToken })
    if (!user) {
      await sendTelegramMessage(
        chatId,
        'This connection link is invalid or has already been used. Please generate a fresh link from Futureace Academy CRM.'
      )
      return { linked: false }
    }

    user.telegramChatId = chatId
    user.telegramLinkedAt = new Date()
    user.telegramLinkToken = ''
    await user.save()

    const statusLine = user.telegramNotificationsEnabled
      ? 'Your CRM notifications are active.'
      : 'Your Chat ID is saved. Your Administrator can now enable your notifications from User Management.'

    await sendTelegramMessage(
      chatId,
      `Connected successfully!\nAccount: ${user.name} (${user.email})\n${statusLine}`
    )

    console.log(`[Telegram] Auto-linked user ${user.name} (${user._id}) -> Chat ID ${chatId}`)
    return { linked: true, userId: user._id.toString(), chatId }
  } catch (err) {
    console.warn('[Telegram] processSingleTelegramUpdate error:', err.message)
    return { linked: false, error: err.message }
  }
}

let telegramPollOffset = 0
let telegramPollInFlight = false
let telegramPollTimer = null
let telegramPollUntil = 0

/**
 * Checks Telegram getUpdates ONCE for pending `/start link_<token>` deep-link connections.
 * Only calls Telegram when triggered on-demand or during an active short-lived linking window.
 */
export async function processTelegramLinkUpdates() {
  const token = getTelegramBotToken()
  if (!token || telegramPollInFlight) return { processed: 0, linkedCount: 0 }

  telegramPollInFlight = true
  try {
    // Skip calling Telegram completely if no user has a pending link token
    const hasPendingToken = await User.exists({
      telegramLinkToken: { $exists: true, $ne: '' },
    })
    if (!hasPendingToken) {
      stopTemporaryLinkPoll()
      return { processed: 0, linkedCount: 0, skipped: true }
    }

    const params = { limit: 50, timeout: 0 }
    if (telegramPollOffset > 0) {
      params.offset = telegramPollOffset
    }

    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
      params,
      timeout: 8000,
    })

    if (!res.data?.ok || !Array.isArray(res.data.result)) {
      return { processed: 0, linkedCount: 0 }
    }

    const updates = res.data.result
    let linkedCount = 0

    for (const upd of updates) {
      if (typeof upd.update_id === 'number' && upd.update_id >= telegramPollOffset) {
        telegramPollOffset = upd.update_id + 1
      }
      const outcome = await processSingleTelegramUpdate(upd)
      if (outcome.linked) linkedCount++
    }

    // Stop temporary poller immediately if no pending tokens remain
    if (linkedCount > 0) {
      const stillPending = await User.exists({
        telegramLinkToken: { $exists: true, $ne: '' },
      })
      if (!stillPending) stopTemporaryLinkPoll()
    }

    return { processed: updates.length, linkedCount }
  } catch (err) {
    const rawMsg = err.response?.data?.description || err.message
    if (!/webhook/i.test(rawMsg)) {
      console.warn('[Telegram Link Check] Warning:', rawMsg)
    }
    return { processed: 0, linkedCount: 0 }
  } finally {
    telegramPollInFlight = false
  }
}

export function stopTemporaryLinkPoll() {
  if (telegramPollTimer) {
    clearInterval(telegramPollTimer)
    telegramPollTimer = null
  }
  telegramPollUntil = 0
}

/**
 * Starts a short-lived listener ONLY when a connect link is actively generated.
 * Auto-stops as soon as all pending users link OR when the window expires (default 3 min).
 */
export function scheduleTemporaryLinkPoll(durationMs = 3 * 60 * 1000) {
  if (!getTelegramBotToken()) return
  telegramPollUntil = Math.max(telegramPollUntil, Date.now() + durationMs)
  if (telegramPollTimer) return

  telegramPollTimer = setInterval(() => {
    if (Date.now() > telegramPollUntil) {
      stopTemporaryLinkPoll()
      return
    }
    processTelegramLinkUpdates().catch(() => {})
  }, 5000)
}
