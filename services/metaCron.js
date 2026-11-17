import cron from 'node-cron'
import MetaIntegration from '../models/MetaIntegration.js'
import { syncMetaLeads } from './metaLeadService.js'

let cronTask = null

/**
 * Start or reload the scheduled Meta sync task
 */
export function startMetaCron() {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }

  // Runs every 15 minutes by default
  cronTask = cron.schedule('*/15 * * * *', async () => {
    try {
      const config = await MetaIntegration.findOne()
      if (!config || !config.autoSync || !config.accessToken || !config.pageId) {
        return
      }

      console.log('⏰ Running scheduled background Meta lead synchronization...')
      const result = await syncMetaLeads()
      console.log(`✅ Background Meta sync finished: +${result.addedCount} new leads.`)
    } catch (err) {
      console.error('Scheduled Meta sync error:', err.response?.data?.error?.message || err.message)
    }
  })

  console.log('🚀 Meta lead sync scheduled (runs every 15 minutes).')
}
