import mongoose from 'mongoose'
import dotenv from 'dotenv'
import User from '../models/User.js'
import Lead from '../models/Lead.js'
import { parseLeadsData } from '../utils/leadParser.js'
import { initialRawLeads } from '../data/initialLeadsRaw.js'

dotenv.config({ path: './.env' })

export const defaultSalesReps = [
  {
    name: 'Jordan Chase',
    email: 'jordan@leadpulse.com',
    role: 'sales',
    title: 'Senior Admissions Lead',
    specialty: 'Healthcare Admin & General',
    avatar: 'JC',
    active: true,
  },
  {
    name: 'Priya Sharma',
    email: 'priya@leadpulse.com',
    role: 'sales',
    title: 'Healthcare Counselor',
    specialty: 'Degree & Postgrad Admissions',
    avatar: 'PS',
    active: true,
  },
  {
    name: 'Rahul Nair',
    email: 'rahul@leadpulse.com',
    role: 'sales',
    title: 'Regional Counselor',
    specialty: 'Kerala Regional (Kochi, Palakkad, Thrissur)',
    avatar: 'RN',
    active: true,
  },
  {
    name: 'Ananya Menon',
    email: 'ananya@leadpulse.com',
    role: 'sales',
    title: 'International Admissions Lead',
    specialty: 'GCC / UAE & Abroad Placements',
    avatar: 'AM',
    active: true,
  },
  {
    name: 'Alex Sterling',
    email: 'admin@leadpulse.com',
    role: 'admin',
    title: 'System Administrator',
    specialty: 'Operations & Management',
    avatar: 'AS',
    active: true,
  },
]

export async function seedDatabase(force = false) {
  try {
    console.log('🌱 Starting MongoDB database seeding check...')

    // 1. Check & Seed Users (Sales Reps + Admin)
    const existingUsersCount = await User.countDocuments()
    let savedReps = []

    if (existingUsersCount === 0 || force) {
      console.log('👉 Seeding sales representatives & admin users into MongoDB...')
      await User.deleteMany({})
      savedReps = await User.insertMany(defaultSalesReps)
      console.log(`✅ Seeded ${savedReps.length} users into MongoDB!`)
    } else {
      savedReps = await User.find({ role: 'sales' })
      console.log(`ℹ️ Found ${existingUsersCount} existing users in MongoDB.`)
    }

    const salesOnly = savedReps.filter(u => u.role === 'sales')

    // 2. Check & Seed Leads from Meta Raw Leads
    const existingLeadsCount = await Lead.countDocuments()

    if (existingLeadsCount === 0 || force) {
      console.log('👉 Parsing & seeding initial Meta leads into MongoDB...')
      await Lead.deleteMany({})

      const parsed = parseLeadsData(initialRawLeads, false)
      const leadsToInsert = parsed.map((item, index) => {
        const leadObj = {
          metaLeadId: item.metaLeadId,
          fullName: item.fullName,
          phone: item.phone,
          email: item.email,
          qualification: item.qualification,
          preferredLocation: item.preferredLocation,
          learningMode: item.learningMode,
          interestReason: item.interestReason,
          careerRole: item.careerRole,
          platform: item.platform,
          campaignName: item.campaignName,
          adsetName: item.adsetName,
          adName: item.adName,
          formName: item.formName,
          customFields: item.customFields,
          createdTime: new Date(Date.now() - (index * 3600000)),
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          callAttempts: 0,
          callbackAt: null,
          notes: [
            {
              text: `Ingested from ${item.platform} Lead Ad form: "${item.formName}"`,
              author: 'Meta Lead Ingestion',
              status: 'Not Contacted',
              subStatus: 'New Lead In Pool',
              timestamp: new Date(),
            },
          ],
        }

        // Pre-assign a few to demonstrate active workflow
        if (index % 3 === 0 && salesOnly.length > 0) {
          const rep = salesOnly[index % salesOnly.length]
          leadObj.assignmentStatus = 'ASSIGNED'
          leadObj.assignedTo = {
            repId: rep._id,
            repName: rep.name,
            repRole: rep.title,
            assignedAt: new Date(Date.now() - (index * 1800000)),
          }

          if (index === 0) {
            leadObj.status = 'Contacted'
            leadObj.subStatus = 'Interested - Sent Brochure'
            leadObj.callAttempts = 2
            leadObj.notes.push({
              text: 'Connected via call. Discussed curriculum & placement guarantee. Brochure sent on WhatsApp.',
              author: rep.name,
              status: 'Contacted',
              subStatus: 'Interested - Sent Brochure',
              timestamp: new Date(Date.now() - 7200000),
            })
          } else if (index === 3) {
            leadObj.status = 'Not Contacted'
            leadObj.subStatus = 'Ringing / No Answer'
            leadObj.callAttempts = 1
            leadObj.notes.push({
              text: 'Call attempt 1: Rang full without answer.',
              author: rep.name,
              status: 'Not Contacted',
              subStatus: 'Ringing / No Answer',
              timestamp: new Date(Date.now() - 3600000),
            })
          } else if (index === 6) {
            leadObj.status = 'Not Contacted'
            leadObj.subStatus = 'Callback Scheduled'
            leadObj.callAttempts = 1
            leadObj.callbackAt = new Date(Date.now() + 86400000)
            leadObj.notes.push({
              text: 'Prospect was driving. Requested callback tomorrow morning.',
              author: rep.name,
              status: 'Not Contacted',
              subStatus: 'Callback Scheduled',
              timestamp: new Date(Date.now() - 1800000),
            })
          }
        }

        return leadObj
      })

      const inserted = await Lead.insertMany(leadsToInsert)
      console.log(`✅ Successfully seeded ${inserted.length} leads directly into MongoDB collection 'leads'!`)
    } else {
      console.log(`ℹ️ Found ${existingLeadsCount} existing leads in MongoDB.`)
    }

    console.log('🎉 MongoDB database check & seed complete.')
  } catch (error) {
    console.error('❌ Error seeding database:', error)
  }
}

// Standalone execution support: node server/scripts/seedDB.js
if (process.argv[1] && process.argv[1].endsWith('seedDB.js')) {
  mongoose
    .connect(process.env.DATABASE_URL)
    .then(async () => {
      console.log('Connected to MongoDB. Running seeder...')
      await seedDatabase(true)
      await mongoose.disconnect()
      console.log('Disconnected.')
      process.exit(0)
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}

