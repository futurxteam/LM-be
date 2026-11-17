import axios from 'axios'
import MetaIntegration from '../models/MetaIntegration.js'
import Lead from '../models/Lead.js'
import { extractLeadFromRow, sanitizePhone } from '../utils/leadParser.js'

/**
 * Send alert message to Telegram Bot if enabled
 */
export async function sendTelegramLeadAlert(config, lead) {
  try {
    const { telegramBotToken, telegramChatId, telegramEnabled } = config.alerts || {}
    if (!telegramEnabled || !telegramBotToken || !telegramChatId) return

    const message =
      `🎯 *New Meta Lead Ingested into Pool!* 🔔\n\n` +
      `👤 *Candidate:* ${lead.fullName}\n` +
      `📞 *Phone:* ${lead.phone}\n` +
      `📧 *Email:* ${lead.email || 'N/A'}\n` +
      `🎓 *Qualification:* ${lead.qualification}\n` +
      `📍 *Preferred Location:* ${lead.preferredLocation}\n` +
      `📋 *Form:* ${lead.formName}\n` +
      `🚀 *Campaign:* ${lead.campaignName || 'Meta Ads'}\n\n` +
      `⚡ *Action:* Log in to CRM to allocate to counselor`

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`
    await axios.post(url, {
      chat_id: telegramChatId,
      text: message,
      parse_mode: 'Markdown',
    })
  } catch (err) {
    console.error('Telegram lead alert failed:', err.response?.data?.description || err.message)
  }
}

/**
 * Send alert to Webhook URL if enabled
 */
export async function sendWebhookLeadAlert(config, lead) {
  try {
    const { webhookUrl, webhookEnabled } = config.alerts || {}
    if (!webhookEnabled || !webhookUrl) return

    await axios.post(
      webhookUrl,
      {
        event: 'meta.lead.created',
        timestamp: new Date().toISOString(),
        lead: {
          id: lead._id,
          metaLeadId: lead.metaLeadId,
          fullName: lead.fullName,
          phone: lead.phone,
          email: lead.email,
          qualification: lead.qualification,
          preferredLocation: lead.preferredLocation,
          formName: lead.formName,
          campaignName: lead.campaignName,
          createdTime: lead.createdTime,
        },
      },
      { timeout: 8000 }
    )
  } catch (err) {
    console.error('Webhook lead alert failed:', err.message)
  }
}

/**
 * Fetch all pages from Meta Graph API (follows paging.next cursor)
 */
async function fetchAllPages(url, params = {}, token) {
  let nextUrl = url
  let firstRequest = true
  const results = []
  let safetyCounter = 0 // Cap at 10 pages per sync to avoid API timeout

  while (nextUrl && safetyCounter < 10) {
    safetyCounter++
    const response = await axios.get(nextUrl, {
      params: firstRequest ? { ...params, access_token: token } : undefined,
      timeout: 15000,
    })

    const data = response.data.data || []
    results.push(...data)

    nextUrl = response.data.paging?.next || null
    firstRequest = false
  }

  return results
}

/**
 * Main Synchronization Function: Fetches from active Meta forms and upserts into Lead model
 */
export async function syncMetaLeads(manualToken, manualPageId) {
  const config = await MetaIntegration.findOne()

  const token = manualToken || config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
  const pageId = manualPageId || config?.pageId || process.env.META_PAGE_ID
  const graphVersion = config?.graphVersion || process.env.META_GRAPH_VERSION || 'v21.0'

  if (!token || !pageId) {
    throw new Error('Meta Page Access Token and Page ID are required to sync leads.')
  }

  const GRAPH_URL = `https://graph.facebook.com/${graphVersion}`

  // 1. Identify active forms
  let activeForms = (config?.selectedForms || []).filter(f => f.active)

  // If no saved active forms, query all forms on the page
  if (activeForms.length === 0) {
    const allForms = await fetchAllPages(
      `${GRAPH_URL}/${pageId}/leadgen_forms`,
      { fields: 'id,name,status,leads_count', limit: 100 },
      token
    )
    activeForms = allForms.map(f => ({
      formId: f.id,
      formName: f.name || 'Meta Lead Form',
      status: f.status || 'ACTIVE',
      active: true,
      leadsCount: f.leads_count || 0,
    }))
  }

  if (activeForms.length === 0) {
    return {
      success: true,
      addedCount: 0,
      duplicatesCount: 0,
      message: 'No lead forms found on this Facebook Page.',
    }
  }

  let totalNewLeadsCount = 0
  let totalDuplicatesCount = 0
  const newlyIngestedLeads = []

  // Incremental sync filter: only fetch leads created after last successful sync (with 60s safety buffer)
  const lastSync = config?.lastSuccessfulSyncAt
  const filtering = lastSync
    ? JSON.stringify([
        {
          field: 'time_created',
          operator: 'GREATER_THAN',
          value: Math.floor((lastSync.getTime() - 60000) / 1000),
        },
      ])
    : undefined

  // 2. Fetch leads from each active form
  for (const form of activeForms) {
    try {
      const leadsParams = {
        fields: 'id,created_time,form_id,ad_id,ad_name,adset_name,campaign_name,platform,is_organic,field_data',
        limit: 100,
        ...(filtering ? { filtering } : {}),
      }

      const rawLeads = await fetchAllPages(`${GRAPH_URL}/${form.formId}/leads`, leadsParams, token)

      for (const metaLead of rawLeads) {
        // Flatten field_data into key-value map
        const rowData = {
          id: metaLead.id,
          created_time: metaLead.created_time,
          ad_id: metaLead.ad_id,
          ad_name: metaLead.ad_name,
          adset_name: metaLead.adset_name,
          campaign_name: metaLead.campaign_name,
          form_id: metaLead.form_id || form.formId,
          form_name: form.formName,
          platform: metaLead.platform || 'ig',
          is_organic: metaLead.is_organic,
        }

        if (Array.isArray(metaLead.field_data)) {
          for (const field of metaLead.field_data) {
            if (field.name) {
              rowData[field.name] = (field.values && field.values[0]) || ''
            }
          }
        }

        const parsed = extractLeadFromRow(rowData)
        if (!parsed) continue

        const cleanPhone = sanitizePhone(parsed.phone)

        // Deduplication check: check metaLeadId or exact phone
        const existing = await Lead.findOne({
          $or: [
            { metaLeadId: parsed.metaLeadId },
            ...(cleanPhone ? [{ phone: cleanPhone, metaLeadId: { $ne: null } }] : []),
          ],
        })

        if (existing) {
          totalDuplicatesCount++
          continue
        }

        // Create new unassigned lead in the pool
        const newLead = new Lead({
          metaLeadId: parsed.metaLeadId,
          fullName: parsed.fullName,
          phone: cleanPhone || parsed.phone,
          email: parsed.email,
          qualification: parsed.qualification,
          preferredLocation: parsed.preferredLocation,
          learningMode: parsed.learningMode,
          interestReason: parsed.interestReason,
          careerRole: parsed.careerRole,
          platform: parsed.platform || 'Instagram',
          campaignName: parsed.campaignName || 'Meta Ads Campaign',
          adsetName: parsed.adsetName,
          adName: parsed.adName,
          formName: form.formName,
          createdTime: parsed.createdTime ? new Date(parsed.createdTime) : new Date(),
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          callAttempts: 0,
          callbackAt: null,
          notes: [
            {
              text: `Ingested live via Meta Graph API from form: "${form.formName}"`,
              author: 'Meta Graph API Sync',
              status: 'Not Contacted',
              subStatus: 'New Lead In Pool',
              timestamp: new Date(),
            },
          ],
        })

        const savedLead = await newLead.save()
        totalNewLeadsCount++
        newlyIngestedLeads.push(savedLead)

        // Dispatch alerts
        if (config) {
          await sendTelegramLeadAlert(config, savedLead)
          await sendWebhookLeadAlert(config, savedLead)
        }
      }

      form.lastSyncAt = new Date()
    } catch (formErr) {
      console.error(`Error syncing leads for form ${form.formId} (${form.formName}):`, formErr.response?.data || formErr.message)
    }
  }

  // 3. Update Sync State in database
  if (config) {
    config.lastSyncAt = new Date()
    config.lastSuccessfulSyncAt = new Date()
    config.lastSyncStatus = 'SUCCESS'
    config.lastSyncMessage = `Synced ${totalNewLeadsCount} new leads (${totalDuplicatesCount} duplicates skipped)`
    await config.save()
  }

  const poolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })

  return {
    success: true,
    addedCount: totalNewLeadsCount,
    duplicatesCount: totalDuplicatesCount,
    poolCount,
    formsCount: activeForms.length,
    newLeads: newlyIngestedLeads.slice(0, 5),
    message:
      totalNewLeadsCount > 0
        ? `Successfully fetched and added ${totalNewLeadsCount} new lead(s) to the pool!`
        : `Sync complete: No new leads. Database is already up to date (${totalDuplicatesCount} existing leads skipped).`,
  }
}
