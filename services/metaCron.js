import cron from 'node-cron'
import MetaIntegration from '../models/MetaIntegration.js'
import { syncMetaLeads } from './metaLeadService.js'

let cronTask = null

/**
 * Start or reload the scheduled Meta sync task
 */
// -------------------------------------------------------------
// Scheduled Meta Lead Poller (Disabled by default: live webhooks handle real-time ingestion)
// -------------------------------------------------------------
export function startMetaCron() {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }

  // Only polls if explicitly enabled by admin in Meta Settings (autoSync === true)
  cronTask = cron.schedule('*/15 * * * *', async () => {
    try {
      const config = await MetaIntegration.findOne()
      if (!config || !config.autoSync || !config.accessToken || !config.pageId) {
        return
      }

      const result = await syncMetaLeads()
      if (result.addedCount > 0) {
        console.log(`ℹ️ [Meta Poller] Added +${result.addedCount} new leads to unassigned pool.`)
      }
    } catch (err) {
      console.error('Meta poller error:', err.response?.data?.error?.message || err.message)
    }
  })

  console.log('⚡ Meta Lead Webhook receiver active. Polling cron set to standby (every 15m, disabled by default).')
}

