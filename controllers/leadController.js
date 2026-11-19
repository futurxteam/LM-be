import mongoose from 'mongoose'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import MetaIntegration from '../models/MetaIntegration.js'
import { parseLeadsData, sanitizePhone } from '../utils/leadParser.js'
import { seedDatabase } from '../scripts/seedDB.js'

// -------------------------------------------------------------
// GET /api/leads (Supports backend pagination by 30)
// -------------------------------------------------------------
export const getLeads = async (req, res) => {
  try {
    const { role, repId, poolOnly, status, qualification, search, page, limit } = req.query
    const filter = {}

    if (poolOnly === 'true') {
      filter.assignmentStatus = 'UNASSIGNED'
    } else if (repId) {
      if (mongoose.Types.ObjectId.isValid(repId)) {
        const objId = new mongoose.Types.ObjectId(repId)
        filter.$or = [
          { 'assignedTo.repId': objId },
          { 'assignedTo.repId': repId },
        ]
      } else {
        // Fallback for non-ObjectId repId (e.g. 'sales_01' from legacy/demo session)
        const matchedUser = await User.findOne({
          $or: [
            { email: new RegExp(repId, 'i') },
            { name: new RegExp(repId, 'i') },
            { role: 'sales' },
          ],
        })
        if (matchedUser) {
          filter.$or = [
            { 'assignedTo.repId': matchedUser._id },
            { 'assignedTo.repId': matchedUser._id.toString() },
          ]
        } else {
          filter.assignmentStatus = 'ASSIGNED'
        }
      }
    } else if (role === 'sales') {
      filter.assignmentStatus = 'ASSIGNED'
    }

    if (status && status !== 'All') {
      if (status === 'Unassigned') {
        filter.assignmentStatus = 'UNASSIGNED'
      } else if (status === 'Assigned') {
        filter.assignmentStatus = 'ASSIGNED'
      } else {
        filter.status = status
      }
    }

    if (qualification && qualification !== 'All') {
      filter.qualification = new RegExp(qualification, 'i')
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i')
      filter.$or = [
        { fullName: regex },
        { phone: regex },
        { email: regex },
        { qualification: regex },
        { preferredLocation: regex },
        { campaignName: regex },
      ]
    }

    // Pagination support
    const isPaginated = page !== undefined || limit !== undefined
    const pageNum = parseInt(page) || 1
    const pageSize = parseInt(limit) || 30
    const skip = (pageNum - 1) * pageSize

    const total = await Lead.countDocuments(filter)

    let queryExec = Lead.find(filter).sort({ createdAt: -1 })
    if (isPaginated) {
      queryExec = queryExec.skip(skip).limit(pageSize)
    }

    const leads = await queryExec.lean()

    const formatted = leads.map(l => ({
      ...l,
      id: l._id.toString(),
    }))

    if (isPaginated) {
      return res.status(200).json({
        leads: formatted,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / pageSize) || 1,
        limit: pageSize,
      })
    }

    res.status(200).json(formatted)
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/leads/reps
// -------------------------------------------------------------
export const getSalesRepsList = async (req, res) => {
  try {
    const reps = await User.find({ role: 'sales' }).lean()

    const repStats = await Promise.all(
      reps.map(async rep => {
        const repId = rep._id
        const assignedCount = await Lead.countDocuments({ 'assignedTo.repId': repId })
        const contactedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          status: 'Contacted',
        })
        const notContactedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          status: 'Not Contacted',
        })
        const enrolledCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          subStatus: { $regex: /enrolled/i },
        })

        const contactRate = assignedCount > 0 ? Math.round((contactedCount / assignedCount) * 100) : 0

        return {
          id: rep._id.toString(),
          _id: rep._id.toString(),
          name: rep.name,
          email: rep.email,
          role: rep.title || rep.role,
          title: rep.title,
          specialty: rep.specialty,
          avatar: rep.avatar,
          active: rep.active,
          totalAssigned: assignedCount,
          assignedCount,
          contactedCount,
          notContactedCount,
          enrolledCount,
          contactRate,
        }
      })
    )

    res.status(200).json(repStats)
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/upload (XLSX, XLS, CSV, TSV) -> Database
// -------------------------------------------------------------
export const uploadLeads = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }

    const parsed = parseLeadsData(req.file.buffer, true)
    if (!parsed || parsed.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid leads extracted from file' })
    }

    let addedCount = 0
    let duplicateCount = 0
    const leadsToInsert = []

    for (const item of parsed) {
      const orConditions = []
      if (item.phone) orConditions.push({ phone: item.phone })
      if (item.email) orConditions.push({ email: item.email.toLowerCase() })
      if (item.metaLeadId) orConditions.push({ metaLeadId: item.metaLeadId })

      let isDuplicate = false
      if (orConditions.length > 0) {
        const existing = await Lead.findOne({ $or: orConditions })
        if (existing) isDuplicate = true
      }

      if (isDuplicate) {
        duplicateCount++
      } else {
        leadsToInsert.push({
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
          createdTime: new Date(),
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          callAttempts: 0,
          callbackAt: null,
          notes: [
            {
              text: `Ingested from ${item.platform} file upload ("${item.formName}")`,
              author: 'File Ingestion Engine',
              status: 'Not Contacted',
              subStatus: 'New Lead In Pool',
              timestamp: new Date(),
            },
          ],
        })
        addedCount++
      }
    }

    if (leadsToInsert.length > 0) {
      await Lead.insertMany(leadsToInsert)
    }

    const totalPoolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })

    res.status(200).json({
      success: true,
      message: `File processed successfully. Added ${addedCount} new leads to MongoDB pool (${duplicateCount} duplicates ignored).`,
      addedCount,
      duplicateCount,
      totalPoolCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: `Upload failed: ${error.message}` })
  }
}

// -------------------------------------------------------------
// POST /api/leads/paste (Raw TSV/CSV) -> Database
// -------------------------------------------------------------
export const pasteLeads = async (req, res) => {
  try {
    const { text } = req.body
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'No text provided' })
    }

    const parsed = parseLeadsData(text, false)
    if (!parsed || parsed.length === 0) {
      return res.status(400).json({ success: false, message: 'Could not extract leads from pasted text' })
    }

    let addedCount = 0
    let duplicateCount = 0
    const leadsToInsert = []

    for (const item of parsed) {
      const orConditions = []
      if (item.phone) orConditions.push({ phone: item.phone })
      if (item.email) orConditions.push({ email: item.email.toLowerCase() })
      if (item.metaLeadId) orConditions.push({ metaLeadId: item.metaLeadId })

      let isDuplicate = false
      if (orConditions.length > 0) {
        const existing = await Lead.findOne({ $or: orConditions })
        if (existing) isDuplicate = true
      }

      if (isDuplicate) {
        duplicateCount++
      } else {
        leadsToInsert.push({
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
          createdTime: new Date(),
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          callAttempts: 0,
          callbackAt: null,
          notes: [
            {
              text: `Ingested from direct text paste ("${item.formName}")`,
              author: 'Meta Paste Engine',
              status: 'Not Contacted',
              subStatus: 'New Lead In Pool',
              timestamp: new Date(),
            },
          ],
        })
        addedCount++
      }
    }

    if (leadsToInsert.length > 0) {
      await Lead.insertMany(leadsToInsert)
    }

    const totalPoolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })

    res.status(200).json({
      success: true,
      message: `Parsed & saved to MongoDB. Added ${addedCount} new leads (${duplicateCount} duplicates skipped).`,
      addedCount,
      duplicateCount,
      totalPoolCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/assign (Manual assignment in MongoDB)
// -------------------------------------------------------------
export const assignLeads = async (req, res) => {
  try {
    const { leadIds, repId } = req.body

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, message: 'leadIds array is required' })
    }

    let rep = null
    if (mongoose.Types.ObjectId.isValid(repId)) {
      rep = await User.findById(repId)
    }
    if (!rep) {
      rep = await User.findOne({
        $or: [
          { email: new RegExp(repId, 'i') },
          { name: new RegExp(repId, 'i') },
          { role: 'sales' },
        ],
      })
    }
    if (!rep) {
      return res.status(404).json({ success: false, message: 'Sales Representative not found in database' })
    }

    const updateResult = await Lead.updateMany(
      { _id: { $in: leadIds } },
      {
        $set: {
          assignmentStatus: 'ASSIGNED',
          'assignedTo.repId': rep._id,
          'assignedTo.repName': rep.name,
          'assignedTo.repRole': rep.title || rep.role,
          'assignedTo.assignedAt': new Date(),
          subStatus: 'Assigned - Pending First Call',
        },
        $push: {
          notes: {
            $each: [
              {
                text: `Manually assigned to ${rep.name} (${rep.title})`,
                author: 'Admin',
                status: 'Not Contacted',
                subStatus: 'Assigned - Pending First Call',
                timestamp: new Date(),
              },
            ],
            $position: 0,
          },
        },
      }
    )

    res.status(200).json({
      success: true,
      message: `Successfully assigned ${updateResult.modifiedCount} lead(s) to ${rep.name}`,
      count: updateResult.modifiedCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/auto-assign (Intelligent / Round-Robin in MongoDB)
// -------------------------------------------------------------
export const autoAssignLeads = async (req, res) => {
  try {
    const { leadIds, mode = 'round-robin' } = req.body

    const activeReps = await User.find({ role: 'sales', active: true })
    if (!activeReps || activeReps.length === 0) {
      return res.status(400).json({ success: false, message: 'No active sales reps found in database' })
    }

    let query = { assignmentStatus: 'UNASSIGNED' }
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      query = { _id: { $in: leadIds } }
    }

    const targetLeads = await Lead.find(query)
    if (targetLeads.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No unassigned leads in pool to allocate.',
        assignedCount: 0,
      })
    }

    let repIndex = 0
    let assignedCount = 0
    const distribution = {}
    activeReps.forEach(r => (distribution[r.name] = 0))

    const internationalRep = activeReps.find(r => r.specialty?.toLowerCase().includes('gcc') || r.title?.toLowerCase().includes('international')) || activeReps[0]

    for (const lead of targetLeads) {
      let chosenRep = null

      if (mode === 'geo-smart') {
        const loc = (lead.preferredLocation || '').toLowerCase()
        const isAbroad =
          loc.includes('uae') ||
          loc.includes('dubai') ||
          loc.includes('abu dhabi') ||
          loc.includes('saudi') ||
          loc.includes('gcc')

        if (isAbroad) {
          chosenRep = internationalRep
        }
      }

      if (!chosenRep) {
        chosenRep = activeReps[repIndex % activeReps.length]
        repIndex++
      }

      lead.assignmentStatus = 'ASSIGNED'
      lead.assignedTo = {
        repId: chosenRep._id,
        repName: chosenRep.name,
        repRole: chosenRep.title || chosenRep.role,
        assignedAt: new Date(),
      }
      lead.subStatus = 'Assigned - Pending First Call'
      lead.notes.unshift({
        text: `Auto-assigned to ${chosenRep.name} (${mode === 'geo-smart' ? 'Geo-Smart GCC Engine' : 'Round-Robin Engine'})`,
        author: 'System Allocator',
        status: lead.status,
        subStatus: 'Assigned - Pending First Call',
        timestamp: new Date(),
      })

      await lead.save()
      distribution[chosenRep.name]++
      assignedCount++
    }

    res.status(200).json({
      success: true,
      message: `Auto-assigned ${assignedCount} leads across ${activeReps.length} sales reps.`,
      assignedCount,
      distribution,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/unassign (Return leads to pool in MongoDB)
// -------------------------------------------------------------
export const unassignLeads = async (req, res) => {
  try {
    const { leadIds } = req.body
    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, message: 'leadIds array required' })
    }

    const result = await Lead.updateMany(
      { _id: { $in: leadIds } },
      {
        $set: {
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          subStatus: 'Returned to Pool',
        },
        $push: {
          notes: {
            $each: [
              {
                text: 'Returned to Unassigned Pool by Admin',
                author: 'Admin',
                status: 'Not Contacted',
                subStatus: 'Returned to Pool',
                timestamp: new Date(),
              },
            ],
            $position: 0,
          },
        },
      }
    )

    res.status(200).json({
      success: true,
      message: `Returned ${result.modifiedCount} lead(s) back to the unassigned pool.`,
      count: result.modifiedCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PATCH /api/leads/:id/status (Contact status & interaction in MongoDB)
// -------------------------------------------------------------
export const updateLeadStatus = async (req, res) => {
  try {
    const { id } = req.params
    const { status, subStatus, note, callbackAt, incrementCallAttempt, author } = req.body

    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found in database' })
    }

    if (status) lead.status = status
    if (subStatus) lead.subStatus = subStatus
    if (callbackAt !== undefined) lead.callbackAt = callbackAt

    if (incrementCallAttempt) {
      lead.callAttempts = (lead.callAttempts || 0) + 1
    }

    if (note && note.trim()) {
      lead.notes.unshift({
        text: note.trim(),
        author: author || lead.assignedTo?.repName || 'Sales Counselor',
        status: lead.status,
        subStatus: lead.subStatus,
        timestamp: new Date(),
      })
    }

    await lead.save()

    const formatted = {
      ...lead.toObject(),
      id: lead._id.toString(),
    }

    res.status(200).json({
      success: true,
      message: 'Lead updated successfully in database',
      lead: formatted,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads (Single manual lead creation)
// -------------------------------------------------------------
export const createLead = async (req, res) => {
  try {
    const newLead = new Lead({
      metaLeadId: `manual_${Date.now()}`,
      fullName: req.body.fullName || req.body.name || 'Untitled Lead',
      phone: sanitizePhone(req.body.phone || ''),
      email: (req.body.email || '').toLowerCase(),
      qualification: req.body.qualification || 'Graduation / Degree',
      preferredLocation: req.body.preferredLocation || 'Kerala',
      learningMode: req.body.learningMode || 'Live Online',
      interestReason: req.body.interestReason || '',
      careerRole: req.body.careerRole || 'Hospital Administration',
      platform: req.body.platform || 'Direct Form',
      campaignName: req.body.campaignName || 'Manual Entry',
      adsetName: 'Direct Inbound',
      adName: 'Direct',
      formName: 'Manual Web Entry',
      createdTime: new Date(),
      assignmentStatus: req.body.assignedTo ? 'ASSIGNED' : 'UNASSIGNED',
      assignedTo: req.body.assignedTo || null,
      status: req.body.status || 'Not Contacted',
      subStatus: req.body.subStatus || 'New Lead In Pool',
      callAttempts: 0,
      callbackAt: null,
      notes: [
        {
          text: 'Lead created manually in system',
          author: 'Admin',
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          timestamp: new Date(),
        },
      ],
    })

    const saved = await newLead.save()
    res.status(201).json({
      success: true,
      lead: { ...saved.toObject(), id: saved._id.toString() },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/reset-db (Temporary tool to clean / reset lead database)
// -------------------------------------------------------------
export const resetLeadDatabase = async (req, res) => {
  try {
    const { mode } = req.body // 'clean' to wipe all leads, or 'reseed' to restore default 34 leads

    if (mode === 'clean') {
      const deleteResult = await Lead.deleteMany({})
      await MetaIntegration.updateMany({}, {
        $set: {
          lastSuccessfulSyncAt: null,
          lastSyncMessage: 'Database cleaned: All leads wiped. Next Meta sync will fetch all submissions.',
        },
      })
      return res.status(200).json({
        success: true,
        message: `Database cleaned: Deleted ${deleteResult.deletedCount} leads. The database is now empty, and Meta sync cutoff has been reset.`,
        deletedCount: deleteResult.deletedCount,
        leadsCount: 0,
      })
    }

    // Default 'reseed' mode
    await seedDatabase(true)
    await MetaIntegration.updateMany({}, {
      $set: {
        lastSuccessfulSyncAt: null,
        lastSyncMessage: 'Database reseeded: Restored baseline leads. Next Meta sync will check all submissions.',
      },
    })
    const count = await Lead.countDocuments()
    return res.status(200).json({
      success: true,
      message: `Database reset & reseeded successfully! Restored ${count} initial Meta leads, and Meta sync cutoff has been reset.`,
      leadsCount: count,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
