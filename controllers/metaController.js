import axios from 'axios'
import MetaIntegration from '../models/MetaIntegration.js'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import { extractLeadFromRow, sanitizePhone } from '../utils/leadParser.js'
import { syncMetaLeads } from '../services/metaLeadService.js'

/**
 * Automatically subscribes a Facebook Page to the Meta App for real-time leadgen webhooks
 */
export async function resolvePageToken(baseToken, pageId, graphVersion = 'v21.0') {
  if (!baseToken || !pageId) return baseToken
  try {
    const res = await axios.get(`https://graph.facebook.com/${graphVersion}/${pageId}`, {
      params: {
        access_token: baseToken,
        fields: 'access_token',
      },
      timeout: 8000,
    })
    if (res.data?.access_token) {
      return res.data.access_token
    }
  } catch (err) {
    // Already a Page Access Token or cannot exchange; fall back to baseToken
  }
  return baseToken
}

export async function ensurePageSubscribed(pageId, token, graphVersion = 'v21.0') {
  if (!pageId || !token) return false
  try {
    const pageToken = await resolvePageToken(token, pageId, graphVersion)
    const res = await axios.post(
      `https://graph.facebook.com/${graphVersion}/${pageId}/subscribed_apps`,
      null,
      {
        params: {
          access_token: pageToken,
          subscribed_fields: 'leadgen',
        },
      }
    )
    console.log(`✅ [Meta Webhook] Subscribed Page ${pageId} to real-time leadgen events.`)
    return res.data?.success === true
  } catch (err) {
    console.warn('⚠️ [Meta Webhook Subscription] Note:', err.response?.data?.error?.message || err.message)
    return false
  }
}

function maskToken(token) {
  if (!token || token.length < 12) return ''
  return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`
}

function normalizeAdAccountId(raw) {
  const cleaned = String(raw || '').trim()
  if (!cleaned) return ''
  return cleaned.startsWith('act_') ? cleaned : `act_${cleaned}`
}

function extractLeadGenFormIdFromCreative(creative) {
  if (!creative || typeof creative !== 'object') return ''
  const spec = creative.object_story_spec || {}
  const directId =
    spec.link_data?.call_to_action?.value?.lead_gen_form_id ||
    spec.video_data?.call_to_action?.value?.lead_gen_form_id ||
    spec.template_data?.call_to_action?.value?.lead_gen_form_id
  if (directId) return String(directId)

  if (Array.isArray(spec.link_data?.child_attachments)) {
    for (const att of spec.link_data.child_attachments) {
      const childId = att?.call_to_action?.value?.lead_gen_form_id
      if (childId) return String(childId)
    }
  }

  if (Array.isArray(creative.asset_feed_spec?.call_to_actions)) {
    for (const cta of creative.asset_feed_spec.call_to_actions) {
      const feedId = cta?.value?.lead_gen_form_id
      if (feedId) return String(feedId)
    }
  }

  return ''
}

async function buildLocalCampaignLookup() {
  const lookup = new Map()
  try {
    const rows = await Lead.aggregate([
      {
        $match: {
          formName: { $exists: true, $nin: ['', null] },
          campaignName: { $exists: true, $nin: ['', null] },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$formName',
          campaignName: { $first: '$campaignName' },
          adName: { $first: '$adName' },
        },
      },
    ])
    for (const row of rows) {
      const key = String(row._id || '').trim().toLowerCase()
      if (key && row.campaignName) {
        lookup.set(key, {
          campaignId: '',
          campaignName: String(row.campaignName).trim(),
          campaignStatus: '',
          adName: String(row.adName || '').trim(),
        })
      }
    }
  } catch (err) {
    console.warn('[Meta Campaign Lookup] Local Lead fallback skipped:', err.message)
  }
  return lookup
}

/**
 * Hybrid campaign resolution for Meta Instant Forms:
 * 1. Marketing API (/act_{adAccountId}/ads) using User/System User token when adAccountId is configured
 * 2. Form leads (/{formId}/leads?fields=id,campaign_name,ad_name,adset_name,is_organic&limit=5) using Page Token
 * 3. Local MongoDB Lead collection fallback by formName
 */
async function resolveFormCampaigns({ forms, token, pageToken, graphVersion = 'v21.0', adAccountId = '' }) {
  const formCampaignMap = new Map()
  let adAccountWarning = ''
  let leadLookupWarning = ''
  let adAccountMappedCount = 0
  let leadLookupMappedCount = 0

  const effectivePageToken = pageToken || token

  // Tier 1: Ad Account Marketing API (optional, works when token is User/System token with ads_read + adAccountId is set)
  const actId = normalizeAdAccountId(adAccountId)
  if (actId && token) {
    try {
      let nextUrl = `https://graph.facebook.com/${graphVersion}/${actId}/ads`
      const params = {
        access_token: token,
        fields: 'name,status,effective_status,campaign{id,name,status,effective_status},creative{object_story_spec,asset_feed_spec}',
        limit: 200,
      }
      let pageCount = 0

      while (nextUrl && pageCount < 3) {
        const adsRes = await axios.get(nextUrl, {
          params: pageCount === 0 ? params : undefined,
          timeout: 12000,
        })
        const ads = adsRes.data?.data || []
        for (const ad of ads) {
          const fid = extractLeadGenFormIdFromCreative(ad.creative)
          const campName = ad.campaign?.name ? String(ad.campaign.name).trim() : ''
          if (!fid || !campName) continue

          const campStatus = String(ad.campaign?.effective_status || ad.campaign?.status || '').toUpperCase()
          const adStatus = String(ad.effective_status || ad.status || '').toUpperCase()
          const isActive = campStatus === 'ACTIVE' && adStatus === 'ACTIVE'

          const existing = formCampaignMap.get(fid)
          if (!existing || (!existing._isActive && isActive)) {
            if (!existing) adAccountMappedCount += 1
            formCampaignMap.set(fid, {
              campaignId: String(ad.campaign?.id || ''),
              campaignName: campName,
              campaignStatus: campStatus,
              adName: String(ad.name || '').trim(),
              _isActive: isActive,
            })
          }
        }
        nextUrl = adsRes.data?.paging?.next || ''
        pageCount += 1
      }
    } catch (adErr) {
      adAccountWarning = adErr.response?.data?.error?.message || adErr.message
      console.warn('[Meta Ads API] Falling back to lead-level campaign mapping:', adAccountWarning)
    }
  }

  // Tier 2: Latest leads from Meta Graph API for unmapped forms with >= 1 submission (does NOT import into CRM pool!)
  const formsNeedingLeadLookup = forms.filter(
    f => !formCampaignMap.has(String(f.formId)) && Number(f.leadsCount || 0) > 0
  )
  const BATCH_SIZE = 8
  for (let i = 0; i < formsNeedingLeadLookup.length; i += BATCH_SIZE) {
    const batch = formsNeedingLeadLookup.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map(f =>
        axios.get(`https://graph.facebook.com/${graphVersion}/${f.formId}/leads`, {
          params: {
            access_token: effectivePageToken,
            fields: 'id,campaign_name,ad_name,adset_name,is_organic',
            limit: 5,
          },
          timeout: 8000,
        })
      )
    )

    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled') {
        if (!leadLookupWarning) {
          leadLookupWarning =
            result.reason?.response?.data?.error?.message || result.reason?.message || 'Lead lookup failed'
        }
        return
      }
      const leads = result.value?.data?.data || []
      const leadWithCampaign = leads.find(l => l?.campaign_name && String(l.campaign_name).trim())
      if (leadWithCampaign) {
        const fid = String(batch[idx].formId)
        leadLookupMappedCount += 1
        formCampaignMap.set(fid, {
          campaignId: '',
          campaignName: String(leadWithCampaign.campaign_name).trim(),
          campaignStatus: '',
          adName: String(leadWithCampaign.ad_name || '').trim(),
        })
      }
    })
  }

  // Tier 3: Local MongoDB Lead collection fallback for any still-unmapped forms
  const stillUnmapped = forms.filter(f => !formCampaignMap.has(String(f.formId)))
  if (stillUnmapped.length > 0) {
    const localLookup = await buildLocalCampaignLookup()
    for (const f of stillUnmapped) {
      const match = localLookup.get(String(f.formName || '').trim().toLowerCase())
      if (match) {
        formCampaignMap.set(String(f.formId), match)
      }
    }
  }

  return {
    formCampaignMap,
    adAccountMappedCount,
    leadLookupMappedCount,
    adAccountWarning,
    leadLookupWarning,
  }
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

    const rawForms = (config.selectedForms || []).map(f => (typeof f.toObject === 'function' ? f.toObject() : { ...f }))
    const needsEnrichment = rawForms.some(f => !f.campaignName)
    let enrichedForms = rawForms
    if (needsEnrichment && rawForms.length > 0) {
      const localLookup = await buildLocalCampaignLookup()
      enrichedForms = rawForms.map(f => {
        if (f.campaignName) return f
        const match = localLookup.get(String(f.formName || '').trim().toLowerCase())
        return match
          ? { ...f, campaignName: match.campaignName, adName: f.adName || match.adName }
          : f
      })
    }

    res.status(200).json({
      success: true,
      config: {
        id: config._id,
        pageId: config.pageId,
        adAccountId: config.adAccountId || '',
        pageName: config.pageName,
        hasToken: !!config.accessToken,
        maskedToken: maskToken(config.accessToken),
        autoSync: config.autoSync,
        syncIntervalMinutes: config.syncIntervalMinutes,
        lastSyncAt: config.lastSyncAt,
        lastSyncStatus: config.lastSyncStatus,
        lastSyncMessage: config.lastSyncMessage,
        selectedForms: enrichedForms,
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
    const { pageId, adAccountId, pageName, accessToken, autoSync, syncIntervalMinutes, alerts } = req.body

    let config = await MetaIntegration.findOne()
    if (!config) {
      config = new MetaIntegration()
    }

    if (pageId !== undefined) config.pageId = String(pageId).trim()
    if (adAccountId !== undefined) config.adAccountId = String(adAccountId).trim()
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

    // Ensure Facebook Page is subscribed for real-time leadgen webhooks
    ensurePageSubscribed(config.pageId, config.accessToken, config.graphVersion).catch(() => {})

    res.status(200).json({
      success: true,
      message: 'Meta Graph API settings saved successfully',
      config: {
        id: config._id,
        pageId: config.pageId,
        adAccountId: config.adAccountId || '',
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
    const { pageId: reqPageId, adAccountId: reqAdAccountId, accessToken: reqToken } = req.body

    const config = await MetaIntegration.findOne()
    const token = reqToken && !reqToken.includes('...') ? reqToken.trim() : config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
    const pageId = reqPageId ? String(reqPageId).trim() : config?.pageId || process.env.META_PAGE_ID
    const adAccountId =
      reqAdAccountId !== undefined
        ? String(reqAdAccountId).trim()
        : config?.adAccountId || process.env.META_AD_ACCOUNT_ID || ''
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

    // Resolve Page Access Token automatically if a User/System User token was supplied
    const pageToken = await resolvePageToken(token, targetPageId, graphVersion)

    // Query Graph API for Lead Gen Forms (paginated up to 3 pages / 300 forms)
    const rawMetaForms = []
    let nextFormsUrl = `https://graph.facebook.com/${graphVersion}/${targetPageId}/leadgen_forms`
    let formsPageCount = 0
    while (nextFormsUrl && formsPageCount < 3) {
      const formsRes = await axios.get(nextFormsUrl, {
        params:
          formsPageCount === 0
            ? {
                access_token: pageToken,
                fields: 'id,name,status,leads_count,created_time,locale',
                limit: 100,
              }
            : undefined,
        timeout: 12000,
      })
      rawMetaForms.push(...(formsRes.data?.data || []))
      nextFormsUrl = formsRes.data?.paging?.next || ''
      formsPageCount += 1
    }

    const baseForms = rawMetaForms.map(f => {
      const existing = config?.selectedForms?.find(sf => String(sf.formId) === String(f.id))
      return {
        formId: String(f.id),
        formName: f.name || 'Untitled Lead Form',
        status: f.status || 'ACTIVE',
        active: existing ? existing.active : true, // Default active on first fetch
        leadsCount: f.leads_count || 0,
        createdTime: f.created_time,
        locale: f.locale,
        activatedAt: existing?.activatedAt || new Date(),
        lastSyncAt: existing?.lastSyncAt,
        assignedGroupId: existing?.assignedGroupId || null,
        assignedCounselorIds: existing?.assignedCounselorIds || [],
        roundRobinIndex: Number(existing?.roundRobinIndex) || 0,
        campaignId: existing?.campaignId || '',
        campaignName: existing?.campaignName || '',
        campaignStatus: existing?.campaignStatus || '',
        adName: existing?.adName || '',
      }
    })

    // Resolve Campaign names using hybrid strategy (Ad Account API -> Meta Form Leads -> Local DB)
    const {
      formCampaignMap,
      adAccountMappedCount,
      leadLookupMappedCount,
      adAccountWarning,
      leadLookupWarning,
    } = await resolveFormCampaigns({
      forms: baseForms,
      token,
      pageToken,
      graphVersion,
      adAccountId,
    })

    const fetchedForms = baseForms.map(f => {
      const resolved = formCampaignMap.get(String(f.formId))
      if (!resolved) return f
      return {
        ...f,
        campaignId: resolved.campaignId || f.campaignId || '',
        campaignName: resolved.campaignName || f.campaignName || '',
        campaignStatus: resolved.campaignStatus || f.campaignStatus || '',
        adName: resolved.adName || f.adName || '',
      }
    })

    const mappedCampaignsCount = fetchedForms.filter(f => f.campaignName).length

    // Update or create config in database so resolved campaign names persist across sessions
    const targetConfig = config || new MetaIntegration()
    targetConfig.pageId = targetPageId
    if (reqAdAccountId !== undefined) targetConfig.adAccountId = adAccountId
    targetConfig.selectedForms = fetchedForms
    if (reqToken && !reqToken.includes('...')) {
      targetConfig.accessToken = reqToken.trim()
    }
    await targetConfig.save()

    res.status(200).json({
      success: true,
      pageId: targetPageId,
      adAccountId,
      pages: discoveredPages,
      formsCount: fetchedForms.length,
      mappedCampaignsCount,
      adAccountMappedCount,
      leadLookupMappedCount,
      adAccountWarning: adAccountWarning || undefined,
      leadLookupWarning: leadLookupWarning || undefined,
      forms: fetchedForms,
      message: `Connected successfully! Found ${fetchedForms.length} Lead Ads form(s) (${mappedCampaignsCount} linked to campaigns).`,
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
    const activeSalesUsers = await User.find({ role: 'sales', active: { $ne: false } })
      .select('_id')
      .lean()
    const activeSalesIdSet = new Set(activeSalesUsers.map(u => u._id.toString()))
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

      const rawAssigned = Array.isArray(f.assignedCounselorIds)
        ? f.assignedCounselorIds
        : f.assignedCounselorId
          ? [f.assignedCounselorId]
          : []
      const cleanAssignedIds = Array.from(
        new Set(rawAssigned.map(String).filter(id => activeSalesIdSet.has(id)))
      )

      return {
        formId: fid,
        formName: f.formName || 'Lead Form',
        campaignId: f.campaignId || existing?.campaignId || '',
        campaignName: f.campaignName || existing?.campaignName || '',
        campaignStatus: f.campaignStatus || existing?.campaignStatus || '',
        adName: f.adName || existing?.adName || '',
        status: f.status || 'ACTIVE',
        active: isNowActive,
        leadsCount: Number(f.leadsCount) || 0,
        activatedAt: activatedAt || now,
        lastSyncAt: existing?.lastSyncAt,
        assignedGroupId: f.assignedGroupId || null,
        assignedCounselorIds: cleanAssignedIds,
        roundRobinIndex: Number(f.roundRobinIndex) || 0,
      }
    })

    // Advance lastSuccessfulSyncAt to now so historical leads from enabled forms are not fetched
    config.lastSuccessfulSyncAt = now

    await config.save()
    const activeCount = config.selectedForms.filter(f => f.active).length

    // Ensure Facebook Page is subscribed for real-time leadgen webhooks
    ensurePageSubscribed(config.pageId, config.accessToken, config.graphVersion).catch(() => {})

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
    const baseToken = config?.accessToken || process.env.META_PAGE_ACCESS_TOKEN
    const pageId = config?.pageId || process.env.META_PAGE_ID
    const graphVersion = config?.graphVersion || process.env.META_GRAPH_VERSION || 'v21.0'

    if (!baseToken) {
      return res.status(400).json({ success: false, message: 'No Meta Page Access Token configured' })
    }

    const token = await resolvePageToken(baseToken, pageId, graphVersion)

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

