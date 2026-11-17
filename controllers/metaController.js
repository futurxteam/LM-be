import axios from 'axios'
import MetaIntegration from '../models/MetaIntegration.js'
import { syncMetaLeads } from '../services/metaLeadService.js'

function maskToken(token) {
  if (!token || token.length < 12) return ''
  return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`
}

// -------------------------------------------------------------
// GET /api/meta/config - Fetch saved settings (token masked)
// -------------------------------------------------------------
export const getMetaConfig = async (req, res) => {
  try {
    let config = await MetaIntegration.findOne()
    if (!config) {
      config = await MetaIntegration.create({
        pageName: 'Futureace Healthcare Academy',
      })
    }

    res.status(200).json({
      success: true,
      config: {
        id: config._id,
        pageId: config.pageId,
        pageName: config.pageName,
        hasToken: !!config.accessToken,
        maskedToken: maskToken(config.accessToken),
        autoSync: config.autoSync,
        syncIntervalMinutes: config.syncIntervalMinutes,
        lastSyncAt: config.lastSyncAt,
        lastSyncStatus: config.lastSyncStatus,
        lastSyncMessage: config.lastSyncMessage,
        selectedForms: config.selectedForms || [],
        alerts: config.alerts || {},
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// -------------------------------------------------------------
// POST /api/meta/config - Save Page ID, Token, Alert Options
// -------------------------------------------------------------
export const saveMetaConfig = async (req, res) => {
  try {
    const { pageId, pageName, accessToken, autoSync, syncIntervalMinutes, alerts } = req.body

    let config = await MetaIntegration.findOne()
    if (!config) {
      config = new MetaIntegration()
    }

    if (pageId !== undefined) config.pageId = String(pageId).trim()
    if (pageName !== undefined) config.pageName = String(pageName).trim()
    if (autoSync !== undefined) config.autoSync = Boolean(autoSync)
    if (syncIntervalMinutes !== undefined) config.syncIntervalMinutes = Number(syncIntervalMinutes)

    // Only update accessToken if a real token is provided (not masked)
    if (accessToken && !accessToken.includes('...')) {
      config.accessToken = accessToken.trim()
    }

    if (alerts) {
      config.alerts = {
        ...config.alerts,
        ...alerts,
      }
    }

    await config.save()

    res.status(200).json({
      success: true,
      message: 'Meta Graph API settings saved successfully',
      config: {
        id: config._id,
        pageId: config.pageId,
        pageName: config.pageName,
        hasToken: !!config.accessToken,
        maskedToken: maskToken(config.accessToken),
        autoSync: config.autoSync,
        syncIntervalMinutes: config.syncIntervalMinutes,
        lastSyncAt: config.lastSyncAt,
        lastSyncStatus: config.lastSyncStatus,
        lastSyncMessage: config.lastSyncMessage,
        selectedForms: config.selectedForms || [],
        alerts: config.alerts || {},
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// -------------------------------------------------------------
// POST /api/meta/fetch-forms - Query Meta Graph API for Forms
// -------------------------------------------------------------
export const fetchPageForms = async (req, res) => {
  try {
    const { pageId: reqPageId, accessToken: reqToken } = req.body

    const config = await MetaIntegration.findOne()
    const token = reqToken && !reqToken.includes('...') ? reqToken.trim() : config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
    const pageId = reqPageId ? String(reqPageId).trim() : config?.pageId || process.env.META_PAGE_ID
    const graphVersion = config?.graphVersion || process.env.META_GRAPH_VERSION || 'v21.0'

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Meta Page Access Token is required. Please paste your token.',
      })
    }

    let targetPageId = pageId
    let discoveredPages = []

    // If Page ID is missing, try detecting connected pages via /me/accounts
    if (!targetPageId) {
      try {
        const accountsRes = await axios.get(
          `https://graph.facebook.com/${graphVersion}/me/accounts`,
          {
            params: {
              access_token: token,
              fields: 'id,name,access_token',
            },
          }
        )
        discoveredPages = accountsRes.data.data || []
        if (discoveredPages.length > 0) {
          targetPageId = discoveredPages[0].id
        }
      } catch (accErr) {
        // Fall back
      }
    }

    if (!targetPageId) {
      return res.status(400).json({
        success: false,
        message: 'Page ID is required. Please provide your Facebook Page ID.',
      })
    }

    // Query Graph API for Lead Gen Forms
    const formsUrl = `https://graph.facebook.com/${graphVersion}/${targetPageId}/leadgen_forms`
    const formsRes = await axios.get(formsUrl, {
      params: {
        access_token: token,
        fields: 'id,name,status,leads_count,created_time,locale',
        limit: 100,
      },
    })

    const fetchedForms = (formsRes.data.data || []).map(f => {
      const existing = config?.selectedForms?.find(sf => sf.formId === f.id)
      return {
        formId: f.id,
        formName: f.name || 'Untitled Lead Form',
        status: f.status || 'ACTIVE',
        active: existing ? existing.active : true, // Default active on first fetch
        leadsCount: f.leads_count || 0,
        createdTime: f.created_time,
        locale: f.locale,
      }
    })

    // Update config in database
    if (config) {
      config.pageId = targetPageId
      config.selectedForms = fetchedForms
      if (reqToken && !reqToken.includes('...')) {
        config.accessToken = reqToken.trim()
      }
      await config.save()
    }

    res.status(200).json({
      success: true,
      pageId: targetPageId,
      pages: discoveredPages,
      formsCount: fetchedForms.length,
      forms: fetchedForms,
      message: `Connected successfully! Found ${fetchedForms.length} Lead Ads form(s).`,
    })
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message
    res.status(500).json({
      success: false,
      message: `Meta API Error: ${errorMsg}`,
      details: err.response?.data?.error,
    })
  }
}

// -------------------------------------------------------------
// POST /api/meta/save-forms - Save Tracked Form Selection
// -------------------------------------------------------------
export const saveSelectedForms = async (req, res) => {
  try {
    const { forms } = req.body

    if (!Array.isArray(forms)) {
      return res.status(400).json({ success: false, message: 'Forms array is required' })
    }

    let config = await MetaIntegration.findOne()
    if (!config) {
      config = new MetaIntegration()
    }

    config.selectedForms = forms.map(f => ({
      formId: String(f.formId),
      formName: f.formName || 'Lead Form',
      status: f.status || 'ACTIVE',
      active: Boolean(f.active),
      leadsCount: Number(f.leadsCount) || 0,
    }))

    await config.save()
    const activeCount = config.selectedForms.filter(f => f.active).length

    res.status(200).json({
      success: true,
      message: `Saved ${activeCount} active lead form(s) for automatic CRM ingestion.`,
      selectedForms: config.selectedForms,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// -------------------------------------------------------------
// POST /api/meta/sync - Manually Trigger Immediate Sync
// -------------------------------------------------------------
export const syncLeads = async (req, res) => {
  try {
    const { accessToken, pageId } = req.body || {}
    const result = await syncMetaLeads(accessToken, pageId)

    res.status(200).json({
      ...result,
      message: result.message || 'Meta leads synchronized successfully',
    })
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message
    console.error('Meta sync error:', err.response?.data || err.message)
    res.status(500).json({
      success: false,
      message: `Failed to synchronize Meta leads: ${errorMsg}`,
    })
  }
}

// -------------------------------------------------------------
// POST /api/meta/test-telegram - Send Test Telegram Notification
// -------------------------------------------------------------
export const testTelegramAlert = async (req, res) => {
  try {
    const { telegramBotToken, telegramChatId } = req.body

    if (!telegramBotToken || !telegramChatId) {
      return res.status(400).json({
        success: false,
        message: 'Telegram Bot Token and Chat ID are required.',
      })
    }

    const testMessage =
      `✅ *Futureace Academy CRM Alert Test*\n\n` +
      `Your Telegram bot is successfully connected! You will receive instant notifications whenever a new lead is captured by Meta Lead Ads.`

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`
    const tgRes = await axios.post(url, {
      chat_id: telegramChatId,
      text: testMessage,
      parse_mode: 'Markdown',
    })

    if (!tgRes.data.ok) {
      return res.status(400).json({
        success: false,
        message: `Telegram Error: ${tgRes.data.description || 'Failed to deliver message'}`,
      })
    }

    res.status(200).json({
      success: true,
      message: 'Test message sent successfully to your Telegram chat/group!',
    })
  } catch (err) {
    const errorMsg = err.response?.data?.description || err.message
    res.status(500).json({ success: false, message: `Telegram Error: ${errorMsg}` })
  }
}

// -------------------------------------------------------------
// POST /api/meta/test-webhook - Send Test Webhook Payload
// -------------------------------------------------------------
export const testWebhookAlert = async (req, res) => {
  try {
    const { webhookUrl } = req.body

    if (!webhookUrl) {
      return res.status(400).json({ success: false, message: 'Webhook URL is required' })
    }

    const response = await axios.post(
      webhookUrl,
      {
        event: 'test_alert',
        message: 'Futureace Academy CRM Webhook connection verified successfully!',
        timestamp: new Date().toISOString(),
      },
      { timeout: 8000 }
    )

    res.status(200).json({
      success: true,
      status: response.status,
      message: `Webhook received with HTTP status ${response.status}`,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: `Webhook error: ${err.message}` })
  }
}
