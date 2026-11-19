import axios from 'axios'
import MetaIntegration from '../models/MetaIntegration.js'
import Lead from '../models/Lead.js'
import { extractLeadFromRow, sanitizePhone } from '../utils/leadParser.js'
import { sendTelegramLeadAlert, sendWebhookLeadAlert } from '../services/metaLeadService.js'

export const WEBHOOK_VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN || 'futureace_leadgen_webhook_2026'

// -------------------------------------------------------------
// GET /api/meta/webhook - Meta Webhook Verification Handshake
// -------------------------------------------------------------
export const verifyMetaWebhook = (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  console.log(`[Meta Webhook] Handshake received: mode=${mode}, token=${token}`)

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ [Meta Webhook] Handshake verified successfully! Returning challenge.')
    return res.status(200).send(challenge)
  }

  console.warn(`❌ [Meta Webhook] Verification failed. Expected token: "${WEBHOOK_VERIFY_TOKEN}", received: "${token}"`)
  return res.status(403).send('Forbidden: Token mismatch')
}

// -------------------------------------------------------------
// POST /api/meta/webhook - Meta Webhook Event Receiver
// -------------------------------------------------------------
export const handleMetaWebhookEvent = async (req, res) => {
  // Acknowledge receipt to Meta immediately (must reply with 200 within 3 seconds)
  res.status(200).send('EVENT_RECEIVED')

  try {
    const { object, entry } = req.body || {}
    if (object !== 'page') return

    console.log(`📡 [Meta Webhook] Event received with ${entry?.length || 0} entry items.`)

    for (const item of entry || []) {
      for (const change of item.changes || []) {
        if (change.field === 'leadgen') {
          const { leadgen_id, form_id, page_id } = change.value || {}
          if (leadgen_id) {
            console.log(`⚡ [Meta Webhook] Incoming new lead: leadgen_id=${leadgen_id}, form_id=${form_id}`)
            await processLiveLead(leadgen_id, form_id, page_id)
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ [Meta Webhook] Error processing event:', err.message)
  }
}

// -------------------------------------------------------------
// Process Incoming Lead in Real-Time
// -------------------------------------------------------------
async function processLiveLead(leadgenId, formId, pageId) {
  try {
    const config = await MetaIntegration.findOne()
    const token = config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
    const graphVersion = config?.graphVersion || process.env.META_GRAPH_VERSION || 'v21.0'

    if (!token) {
      console.error('❌ [Meta Webhook] Cannot fetch lead: No Page Access Token configured')
      return
    }

    // 1. Fetch full candidate lead data from Meta Graph API
    const response = await axios.get(`https://graph.facebook.com/${graphVersion}/${leadgenId}`, {
      params: {
        access_token: token,
        fields: 'id,created_time,form_id,ad_id,ad_name,adset_name,campaign_name,platform,field_data',
      },
      timeout: 10000,
    })

    const raw = response.data
    if (!raw) return

    const formConfig = config?.selectedForms?.find(f => f.formId === String(formId || raw.form_id))
    const formName = formConfig?.formName || 'Meta Lead Form'

    // 2. Flatten field_data
    const rowData = {
      id: raw.id,
      created_time: raw.created_time,
      ad_id: raw.ad_id,
      ad_name: raw.ad_name,
      adset_name: raw.adset_name,
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
    if (!parsed) {
      console.warn('⚠️ [Meta Webhook] Failed to parse lead fields:', rowData)
      return
    }

    const cleanPhone = sanitizePhone(parsed.phone)

    // 3. Deduplication Check
    const existing = await Lead.findOne({
      $or: [
        { metaLeadId: String(raw.id) },
        ...(cleanPhone ? [{ phone: cleanPhone }] : []),
      ],
    })

    if (existing) {
      console.log(`ℹ️ [Meta Webhook] Duplicate lead skipped: ${parsed.fullName} (${cleanPhone || raw.id})`)
      return
    }

    // 4. Create and Save New Lead in Pool
    const newLead = new Lead({
      metaLeadId: String(raw.id),
      fullName: parsed.fullName || 'Unknown Candidate',
      phone: cleanPhone || parsed.phone,
      email: parsed.email,
      qualification: parsed.qualification,
      preferredLocation: parsed.preferredLocation,
      learningMode: parsed.learningMode,
      interestReason: parsed.interestReason,
      careerRole: parsed.careerRole,
      platform: parsed.platform || 'Instagram',
      campaignName: parsed.campaignName || 'Meta Ads',
      adsetName: parsed.adsetName,
      adName: parsed.adName,
      formName,
      createdTime: parsed.createdTime ? new Date(parsed.createdTime) : new Date(),
      assignmentStatus: 'UNASSIGNED',
      assignedTo: null,
      status: 'Not Contacted',
      subStatus: 'New Lead In Pool',
      callAttempts: 0,
      notes: [
        {
          text: `⚡ Ingested instantly via Meta Lead Ads Webhook from form: "${formName}"`,
          author: 'Meta Real-Time Webhook',
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          timestamp: new Date(),
        },
      ],
    })

    const savedLead = await newLead.save()
    console.log(`🎉 [Meta Webhook] Successfully added new lead to pool: ${savedLead.fullName} (${savedLead.phone})`)

    // 5. Send Alerts
    if (config) {
      await sendTelegramLeadAlert(config, savedLead)
      await sendWebhookLeadAlert(config, savedLead)

      // Update form's leadsCount and timestamp
      if (formConfig) {
        formConfig.leadsCount = (formConfig.leadsCount || 0) + 1
        formConfig.lastSyncAt = new Date()
      }
      config.lastSyncAt = new Date()
      config.lastSuccessfulSyncAt = new Date()
      config.lastSyncStatus = 'SUCCESS'
      config.lastSyncMessage = `Live webhook: Captured 1 new lead (${savedLead.fullName})`
      await config.save()
    }
  } catch (err) {
    console.error(`❌ [Meta Webhook] Error fetching lead ${leadgenId}:`, err.response?.data || err.message)
  }
}

// -------------------------------------------------------------
// POST /api/meta/subscribe-page-webhook - Subscribes Facebook Page to Leadgen Webhook
// -------------------------------------------------------------
export const subscribePageToWebhook = async (req, res) => {
  try {
    const config = await MetaIntegration.findOne()
    const token = config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
    const pageId = config?.pageId || process.env.META_PAGE_ID
    const graphVersion = config?.graphVersion || 'v21.0'

    if (!token || !pageId) {
      return res.status(400).json({
        success: false,
        message: 'Page ID and Meta Page Access Token are required to subscribe page.',
      })
    }

    const response = await axios.post(
      `https://graph.facebook.com/${graphVersion}/${pageId}/subscribed_apps`,
      null,
      {
        params: {
          access_token: token,
          subscribed_fields: 'leadgen',
        },
      }
    )

    res.status(200).json({
      success: true,
      message: 'Facebook Page successfully subscribed to real-time Leadgen Webhooks!',
      data: response.data,
    })
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message
    res.status(500).json({
      success: false,
      message: `Failed to subscribe page: ${errorMsg}`,
      details: err.response?.data?.error,
    })
  }
}

