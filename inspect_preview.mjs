import { connectDB } from './config/db.js'
import MetaIntegration from './models/MetaIntegration.js'
import axios from 'axios'

async function inspect() {
  await connectDB()
  const config = await MetaIntegration.findOne()
  console.log('--- META INTEGRATION ---')
  console.log('UpdatedAt:', config?.updatedAt)
  const form = config?.selectedForms?.find(f => f.formId === '1844777193333748')
  console.log('Form in selectedForms:', form)

  const token = config?.accessToken
  const graphVersion = config?.graphVersion || 'v21.0'

  if (!token) {
    console.log('No token configured!')
    process.exit(0)
  }

  // 1. Query Meta for the form object itself
  try {
    const formRes = await axios.get(`https://graph.facebook.com/${graphVersion}/1844777193333748`, {
      params: { access_token: token, fields: 'id,name,status,leads_count' }
    })
    console.log('Meta Form Object:', formRes.data)
  } catch (err) {
    console.log('Form Object Error:', err.response?.data || err.message)
  }

  // 2. Query Meta for leads of this form
  try {
    const leadsRes = await axios.get(`https://graph.facebook.com/${graphVersion}/1844777193333748/leads`, {
      params: { access_token: token, fields: 'id,created_time', limit: 100 }
    })
    console.log('Meta Leads Response count:', leadsRes.data.data?.length)
  } catch (err) {
    console.log('Leads Query Error:', err.response?.data || err.message)
  }

  process.exit(0)
}

inspect().catch(err => {
  console.error(err)
  process.exit(1)
})

