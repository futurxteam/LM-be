import cron from 'node-cron'
import MetaIntegration from '../models/MetaIntegration.js'
import { syncMetaLeads } from './metaLeadService.js'

let cronTask = null

/**
 * Start or reload the scheduled Meta sync task
 */
// -------------------------------------------------------------
// Scheduled Meta Lead Auto-Ingestion (Runs every 1 minute)
// -------------------------------------------------------------
export function startMetaCron() {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }

  // Runs every 1 minute to ensure leads enter the pool with zero manual effort
  cronTask = cron.schedule('* * * * *', async () => {
    try {
      const config = await MetaIntegration.findOne()
      if (!config || !config.autoSync || !config.accessToken || !config.pageId) {
        return
      }

      const result = await syncMetaLeads()
      if (result.addedCount > 0) {
        console.log(`⚡ [Auto-Ingestion] Automatically placed +${result.addedCount} new Meta leads directly into the pool!`)
      }
    } catch (err) {
      console.error('Auto-sync error:', err.response?.data?.error?.message || err.message)
    }
  })

  console.log('🚀 Automated Meta lead ingestion active: Checking active forms every 60 seconds.')
}

