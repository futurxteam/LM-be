import axios from 'axios'
import MetaIntegration from '../models/MetaIntegration.js'
import Lead from '../models/Lead.js'
import { extractLeadFromRow, sanitizePhone } from '../utils/leadParser.js'
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

    const existingFormsMap = new Map((config.selectedForms || []).map(f => [String(f.formId), f]))
    const now = new Date()

    config.selectedForms = forms.map(f => {
      const fid = String(f.formId)
      const existing = existingFormsMap.get(fid)
      const isNowActive = Boolean(f.active)
      const wasActive = existing ? existing.active : false

      let activatedAt = existing?.activatedAt
      if (isNowActive && !wasActive) {
        // Newly enabled form: baseline is NOW so past submissions are never imported
        activatedAt = now
      } else if (!activatedAt && isNowActive) {
        activatedAt = now
      }

      return {
        formId: fid,
        formName: f.formName || 'Lead Form',
        status: f.status || 'ACTIVE',
        active: isNowActive,
        leadsCount: Number(f.leadsCount) || 0,
        activatedAt: activatedAt || now,
        assignedGroupId: f.assignedGroupId || null,
        assignedCounselorIds: Array.isArray(f.assignedCounselorIds) ? f.assignedCounselorIds : (f.assignedCounselorId ? [f.assignedCounselorId] : []),
        roundRobinIndex: Number(f.roundRobinIndex) || 0,
      }
    })

    // Advance lastSuccessfulSyncAt to now so historical leads from enabled forms are not fetched
    config.lastSuccessfulSyncAt = now

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
    const { accessToken, pageId, forceFullSync } = req.body || {}
    const result = await syncMetaLeads(accessToken, pageId, Boolean(forceFullSync))

    res.status(200).json({
      ...result,
      message: result.message || 'Meta leads synchronized successfully',
    })
  } catch (err) {
    const isTokenExpired =
      err.response?.data?.error?.code === 190 ||
      err.response?.data?.error?.type === 'OAuthException' ||
      /expired|token/i.test(err.response?.data?.error?.message || err.message)

    const errorMsg = err.response?.data?.error?.message || err.message
    console.error('Meta sync error:', err.response?.data || err.message)
    res.status(500).json({
      success: false,
      isTokenExpired,
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

// -------------------------------------------------------------
// POST /api/meta/preview-form-leads - Preview leads from a specific form
// -------------------------------------------------------------
export const previewFormLeads = async (req, res) => {
  try {
    const { formId } = req.body
    if (!formId) {
      return res.status(400).json({ success: false, message: 'formId is required' })
    }

    const config = await MetaIntegration.findOne()
    const token = config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
    const graphVersion = config?.graphVersion || process.env.META_GRAPH_VERSION || 'v21.0'

    if (!token) {
      return res.status(400).json({ success: false, message: 'No Meta Page Access Token configured' })
    }

    const formConfig = config?.selectedForms?.find(f => f.formId === String(formId))
    const formName = formConfig?.formName || 'Meta Lead Form'

    // Fetch leads from Meta Graph API
    const response = await axios.get(`https://graph.facebook.com/${graphVersion}/${formId}/leads`, {
      params: {
        access_token: token,
        fields: 'id,created_time,form_id,ad_id,ad_name,campaign_name,platform,field_data',
        limit: 100,
      },
      timeout: 15000,
    })

    const rawLeads = response.data.data || []
    const parsedLeads = []

    for (const raw of rawLeads) {
      const rowData = {
        id: raw.id,
        created_time: raw.created_time,
        ad_id: raw.ad_id,
        ad_name: raw.ad_name,
        campaign_name: raw.campaign_name,
        form_id: raw.form_id || formId,
        form_name: formName,
        platform: raw.platform || 'Instagram',
      }

      if (Array.isArray(raw.field_data)) {
        for (const field of raw.field_data) {
          if (field.name) {
            rowData[field.name] = (field.values && field.values[0]) || ''
          }
        }
      }

      const parsed = extractLeadFromRow(rowData)
      if (!parsed) continue

      const cleanPhone = sanitizePhone(parsed.phone)

      // Check if already exists in MongoDB
      const existing = await Lead.findOne({
        $or: [
          { metaLeadId: parsed.metaLeadId },
          ...(cleanPhone ? [{ phone: cleanPhone }] : []),
        ],
      })

      let systemState = 'NOT_IN_SYSTEM' // 'IN_POOL' | 'ASSIGNED' | 'NOT_IN_SYSTEM'
      let assignedAdvisor = null
      if (existing) {
        if (existing.assignmentStatus === 'ASSIGNED' && existing.assignedTo?.repName) {
          systemState = 'ASSIGNED'
          assignedAdvisor = existing.assignedTo.repName
        } else {
          systemState = 'IN_POOL'
        }
      }

      parsedLeads.push({
        metaLeadId: parsed.metaLeadId,
        fullName: parsed.fullName || 'Unknown Candidate',
        phone: cleanPhone || parsed.phone,
        email: parsed.email || '',
        qualification: parsed.qualification || 'Other / Not Specified',
        preferredLocation: parsed.preferredLocation || 'Anywhere',
        learningMode: parsed.learningMode || 'Offline Class',
        formId,
        formName,
        campaignName: parsed.campaignName || 'Meta Ads',
        createdTime: parsed.createdTime,
        isExistingInDb: !!existing,
        systemState,
        assignedAdvisor,
        existingLeadId: existing?._id,
        existingStatus: existing?.status,
        existingAssignment: assignedAdvisor,
      })
    }

    // Synchronize the form's cached submission count with live Meta count
    if (formConfig && config) {
      formConfig.leadsCount = parsedLeads.length
      await config.save()
    }

    res.status(200).json({
      success: true,
      formId,
      formName,
      totalFetched: parsedLeads.length,
      newCount: parsedLeads.filter(l => l.systemState === 'NOT_IN_SYSTEM').length,
      inPoolCount: parsedLeads.filter(l => l.systemState === 'IN_POOL').length,
      assignedCount: parsedLeads.filter(l => l.systemState === 'ASSIGNED').length,
      existingCount: parsedLeads.filter(l => l.isExistingInDb).length,
      leads: parsedLeads,
    })
  } catch (err) {
    const isTokenExpired =
      err.response?.data?.error?.code === 190 ||
      err.response?.data?.error?.type === 'OAuthException' ||
      /expired|token/i.test(err.response?.data?.error?.message || err.message)

    const errorMsg = err.response?.data?.error?.message || err.message
    res.status(500).json({
      success: false,
      isTokenExpired,
      message: `Failed to preview leads: ${errorMsg}`,
      details: err.response?.data?.error,
    })
  }
}

// -------------------------------------------------------------
// POST /api/meta/import-selected-leads - Ingest selected leads to Pool
// -------------------------------------------------------------
export const importSelectedLeads = async (req, res) => {
  try {
    const { leads } = req.body
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, message: 'Leads array is required' })
    }

    let addedCount = 0
    let skippedCount = 0

    for (const leadData of leads) {
      const cleanPhone = sanitizePhone(leadData.phone)

      // Duplicate check
      const existing = await Lead.findOne({
        $or: [
          { metaLeadId: leadData.metaLeadId },
          ...(cleanPhone ? [{ phone: cleanPhone }] : []),
        ],
      })

      if (existing) {
        skippedCount++
        continue
      }

      const newLead = new Lead({
        metaLeadId: leadData.metaLeadId,
        fullName: leadData.fullName || 'Unknown Candidate',
        phone: cleanPhone || leadData.phone,
        email: leadData.email,
        qualification: leadData.qualification,
        preferredLocation: leadData.preferredLocation,
        learningMode: leadData.learningMode,
        formName: leadData.formName,
        campaignName: leadData.campaignName || 'Meta Ads',
        createdTime: leadData.createdTime ? new Date(leadData.createdTime) : new Date(),
        assignmentStatus: 'UNASSIGNED',
        assignedTo: null,
        status: 'Not Contacted',
        subStatus: 'New Lead In Pool',
        callAttempts: 0,
        notes: [
          {
            text: `Imported via UI Form Preview from: "${leadData.formName}"`,
            author: 'Admin Manual Select',
            status: 'Not Contacted',
            subStatus: 'New Lead In Pool',
            timestamp: new Date(),
          },
        ],
      })

      await newLead.save()
      addedCount++
    }

    res.status(200).json({
      success: true,
      addedCount,
      skippedCount,
      message: `Successfully added ${addedCount} lead(s) to unassigned pool (${skippedCount} existing skipped).`,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

