import axios from 'axios'
import MetaIntegration from '../models/MetaIntegration.js'
import Lead from '../models/Lead.js'
import { extractLeadFromRow, sanitizePhone } from '../utils/leadParser.js'
import { sendTelegramLeadAlert, sendWebhookLeadAlert } from '../services/metaLeadService.js'
import { allocateLead } from '../services/allocationService.js'

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

    console.log('\n' + '='.repeat(68))
    console.log(`🔔 [META WEBHOOK RECEIVED] ${new Date().toLocaleString()}`)
    console.log(`   Object: ${object || 'unknown'} | Entries: ${entry?.length || 0}`)
    console.log('='.repeat(68))

    if (object !== 'page') {
      console.warn(`⚠️ [Meta Webhook Ignored] Received non-page event object: "${object}" (expected "page").`)
      return
    }

    if (!Array.isArray(entry) || entry.length === 0) {
      console.warn('⚠️ [Meta Webhook Ignored] Empty entries array in payload.')
      return
    }

    for (const item of entry) {
      const pageId = item.id
      for (const change of item.changes || []) {
        console.log(`   Field: "${change.field}" | Page ID: ${pageId || change.value?.page_id}`)

        if (change.field === 'leadgen') {
          const { leadgen_id, form_id, page_id: eventPageId } = change.value || {}
          if (leadgen_id) {
            console.log(`⚡ [Meta Webhook] New Lead Detected: Leadgen ID = ${leadgen_id}, Form ID = ${form_id}`)
            await processLiveLead(leadgen_id, form_id, eventPageId || pageId)
          } else {
            console.warn('⚠️ [Meta Webhook Error] "leadgen" change event received without leadgen_id:', change.value)
          }
        } else {
          console.log(`ℹ️ [Meta Webhook] Skipping non-leadgen field event: "${change.field}"`)
        }
      }
    }
  } catch (err) {
    console.error('❌ [Meta Webhook Fatal Error] Uncaught error handling event:', err.message, err.stack)
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
      console.error('❌ [Meta Webhook Error: Token Missing] Cannot fetch lead: No Page Access Token configured in database or environment.')
      return
    }

    // Special handling for Meta Developer Dashboard Test Button (sends dummy placeholder 444444444444)
    if (String(leadgenId) === '444444444444' || String(leadgenId).startsWith('444444')) {
      console.log('\n' + '='.repeat(68))
      console.log('✅ [META DASHBOARD TEST PING VERIFIED SUCCESSFULLY]')
      console.log('   Meta successfully connected to your server and delivered the webhook payload!')
      console.log('   (Note: "444444444444" is Meta\'s generic test placeholder. Real leads will fetch and allocate live candidates).')
      console.log('='.repeat(68) + '\n')
      return
    }

    // Strictly gate ingestion to explicitly enabled (active: true) forms only
    if (formId) {
      const preFormConfig = config?.selectedForms?.find(f => String(f.formId) === String(formId))
      if (!preFormConfig || !preFormConfig.active) {
        console.log(
          `⏭️ [Meta Webhook Ignored] Form "${preFormConfig?.formName || formId}" (ID: ${formId}) is NOT enabled (active: false). Skipping lead ${leadgenId} so it does not enter System Pool.`
        )
        return
      }
    }

    // 1. Fetch full candidate lead data from Meta Graph API
    console.log(`📡 [Meta Webhook] Querying Meta Graph API for leadgen_id: ${leadgenId}...`)
    let response
    try {
      response = await axios.get(`https://graph.facebook.com/${graphVersion}/${leadgenId}`, {
        params: {
          access_token: token,
          fields: 'id,created_time,form_id,ad_id,ad_name,adset_name,campaign_name,platform,field_data',
        },
        timeout: 10000,
      })
    } catch (apiErr) {
      const errData = apiErr.response?.data?.error
      console.error('❌ [Meta Webhook Error: Graph API Failed]')
      console.error(`   HTTP Status: ${apiErr.response?.status || 'N/A'}`)
      console.error(`   Message:     ${errData?.message || apiErr.message}`)
      console.error(`   Code:        ${errData?.code || 'N/A'}`)
      console.error(`   Type:        ${errData?.type || 'N/A'}`)
      console.error(`   FBTrace ID:  ${errData?.fbtrace_id || 'N/A'}`)
      return
    }

    const raw = response.data
    if (!raw) {
      console.error(`❌ [Meta Webhook Error] Empty response body from Meta Graph API for lead ${leadgenId}`)
      return
    }

    const resolvedFormId = String(formId || raw.form_id || '')
    const formConfig = config?.selectedForms?.find(f => String(f.formId) === resolvedFormId)
    if (!formConfig || !formConfig.active) {
      console.log(
        `⏭️ [Meta Webhook Ignored] Form "${formConfig?.formName || resolvedFormId}" (ID: ${resolvedFormId}) is NOT enabled (active: false). Skipping lead ${leadgenId}.`
      )
      return
    }
    const formName = formConfig.formName || 'Meta Lead Form'

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
      console.warn('❌ [Meta Webhook Error: Parsing Failed] Could not extract lead fields from rowData:', JSON.stringify(rowData, null, 2))
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
      console.warn(`⚠️ [Meta Webhook Skipped: Duplicate] Candidate "${parsed.fullName}" (Phone: ${cleanPhone || raw.id}) already exists in CRM (Lead ID: ${existing._id}).`)
      return
    }

    // 4. Capacity-Aware Round-Robin Lead Allocation
    console.log(`⚖️ [Meta Webhook] Running lead assignment engine for form: "${formName}" (ID: ${formId || raw.form_id})...`)
    const allocation = await allocateLead(formId || raw.form_id)

    const newLead = new Lead({
      metaLeadId: String(raw.id),
      fullName: parsed.fullName || 'Unknown Candidate',
      phone: cleanPhone || parsed.phone,
      email: parsed.email,
      qualification: parsed.qualification || 'Degree',
      age: parsed.age || null,
      state: parsed.state || 'Kerala',
      otherState: parsed.otherState || '',
      district: parsed.district || parsed.preferredLocation || 'Ernakulam',
      courseProgram: parsed.courseProgram || 'Healthcare Management',
      courseVariant: parsed.courseVariant || '',
      customerCategory: parsed.customerCategory || 'Ongoing Student',
      preferredLocation: parsed.preferredLocation || 'Not Specified',
      learningMode: parsed.learningMode || 'Flexible',
      interestReason: parsed.interestReason || '',
      careerRole: parsed.careerRole || 'Hospital Administration',
      platform: parsed.platform || 'Instagram',
      campaignName: parsed.campaignName || 'Meta Ads',
      adsetName: parsed.adsetName,
      adName: parsed.adName,
      formName,
      createdTime: parsed.createdTime ? new Date(parsed.createdTime) : new Date(),
      assignmentStatus: allocation.assignmentStatus,
      assignedTo: allocation.assignedTo,
      groupId: allocation.groupId,
      status: 'Not Contacted',
      subStatus: allocation.assignedTo ? 'Assigned to Counselor' : 'New Lead In Pool',
      callAttempts: 0,
      notes: [
        {
          text: allocation.assignedTo
            ? `⚡ Live Webhook Ingestion: Automatically assigned to Counselor ${allocation.assignedTo.repName} (Form: "${formName}")`
            : `⚡ Live Webhook Ingestion: Added to system pool from form: "${formName}"`,
          author: 'Meta Real-Time Allocation Engine',
          status: 'Not Contacted',
          subStatus: allocation.assignedTo ? 'Assigned to Counselor' : 'New Lead In Pool',
          timestamp: new Date(),
        },
      ],
    })

    let savedLead
    try {
      savedLead = await newLead.save()
    } catch (saveErr) {
      console.error('❌ [Meta Webhook Error: Database Save Failed]', saveErr.message, saveErr)
      return
    }

    console.log('\n' + '='.repeat(68))
    if (allocation.assignedTo) {
      console.log('🎯 [LEAD ASSIGNMENT SUCCESSFUL - LIVE WEBHOOK]')
      console.log(`   Candidate:   ${savedLead.fullName}`)
      console.log(`   Phone:       ${savedLead.phone}`)
      console.log(`   Email:       ${savedLead.email || 'N/A'}`)
      console.log(`   Form:        ${formName} (${formId || raw.form_id})`)
      console.log(`   Assigned To: ${allocation.assignedTo.repName} [${allocation.assignedTo.repRole}]`)
      console.log(`   Status:      ${savedLead.status} • ${savedLead.subStatus}`)
    } else {
      console.log('📥 [LEAD INGESTION - PLACED IN SYSTEM POOL]')
      console.log(`   Candidate:   ${savedLead.fullName}`)
      console.log(`   Phone:       ${savedLead.phone}`)
      console.log(`   Form:        ${formName} (${formId || raw.form_id})`)
      console.log(`   Status:      UNASSIGNED (In Pool - No counselor assigned)`)
    }
    console.log('='.repeat(68) + '\n')

    // 5. Send Alerts
    if (config) {
      try {
        await sendTelegramLeadAlert(config, savedLead)
      } catch (tgErr) {
        console.warn('⚠️ [Meta Webhook Warning: Telegram Alert Failed]:', tgErr.message)
      }
      try {
        await sendWebhookLeadAlert(config, savedLead)
      } catch (whErr) {
        console.warn('⚠️ [Meta Webhook Warning: Outbound Webhook Alert Failed]:', whErr.message)
      }

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
    console.error(`❌ [Meta Webhook Error: Processing Failed for lead ${leadgenId}]:`, err.message, err.stack)
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

