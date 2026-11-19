import { connectDB } from './config/db.js'
import Lead from './models/Lead.js'
import MetaIntegration from './models/MetaIntegration.js'

async function check() {
  await connectDB()
  const config = await MetaIntegration.findOne()
  console.log('lastSyncMessage:', config?.lastSyncMessage)
  console.log('lastSyncAt:', config?.lastSyncAt)
  const allLeads = await Lead.find({}).sort({ createdAt: -1 }).limit(5)
  console.log('Top 5 latest leads in DB:')
  for (const l of allLeads) {
    console.log(`- ${l.fullName} | ID: ${l.metaLeadId} | created: ${l.createdAt} | status: ${l.status}`)
  }
  process.exit(0)
}

check().catch(err => {
  console.error(err)
  process.exit(1)
})

