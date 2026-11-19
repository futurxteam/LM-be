import mongoose from 'mongoose'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import MetaIntegration from '../models/MetaIntegration.js'
import { parseLeadsData, sanitizePhone } from '../utils/leadParser.js'
import { seedDatabase } from '../scripts/seedDB.js'
import { allocateLead } from '../services/allocationService.js'

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

        const completedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          isCompleted: true,
        })
        const droppedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          isDropped: true,
        })
        const activeCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          isCompleted: { $ne: true },
          isDropped: { $ne: true },
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
          groupId: rep.groupId || null,
          isGroupManager: Boolean(rep.isGroupManager),
          totalAssigned: assignedCount,
          assignedCount,
          activeCount,
          completedCount,
          droppedCount,
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
    const { status, subStatus, note, callbackAt, incrementCallAttempt, author, isCompleted, isDropped, droppedReason } = req.body

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

    // Lifecycle states: Dropped vs Completed
    if (isCompleted !== undefined) {
      lead.isCompleted = Boolean(isCompleted)
      if (lead.isCompleted) {
        lead.isDropped = false
        lead.completedAt = new Date()
      }
    } else if (subStatus && /enrolled/i.test(subStatus)) {
      lead.isCompleted = true
      lead.isDropped = false
      lead.completedAt = lead.completedAt || new Date()
    }

    if (isDropped !== undefined) {
      lead.isDropped = Boolean(isDropped)
      if (lead.isDropped) {
        lead.isCompleted = false
        lead.droppedReason = droppedReason || note || 'Lead dropped / lost'
      }
    } else if (subStatus && /dropped|not interested|lost|junk|invalid/i.test(subStatus)) {
      lead.isDropped = true
      lead.isCompleted = false
      lead.droppedReason = lead.droppedReason || subStatus
    }

    if (note && note.trim()) {
      lead.notes.unshift({
        text: note.trim(),
        author: author || lead.assignedTo?.repName || 'Admissions Counselor',
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
// POST /api/leads (Manual lead typing / direct creation)
// -------------------------------------------------------------
export const createLead = async (req, res) => {
  try {
    const {
      fullName,
      name,
      phone,
      email,
      qualification,
      age,
      state,
      otherState,
      district,
      courseProgram,
      courseVariant,
      customerCategory,
      assignMode,
      assignedTo,
      groupId,
      formId,
      status,
      subStatus,
      author,
    } = req.body

    const nameVal = (fullName || name || '').trim()
    if (!nameVal) {
      return res.status(400).json({ success: false, message: 'Name is required' })
    }

    // Determine Assignment:
    // If explicitly set to 'pool', keep UNASSIGNED.
    // If specific counselor passed, assign directly.
    // Default: Run capacity-aware round-robin to assign directly to counselor's personal queue!
    let leadAssignmentStatus = 'UNASSIGNED'
    let leadAssignedTo = null
    let leadGroupId = groupId || null

    if (assignMode === 'pool') {
      leadAssignmentStatus = 'UNASSIGNED'
      leadAssignedTo = null
      leadGroupId = null
    } else if (assignedTo && (assignedTo.repId || assignedTo.id)) {
      const repId = assignedTo.repId || assignedTo.id
      const counselor = await User.findById(repId)
      leadAssignmentStatus = 'ASSIGNED'
      leadAssignedTo = {
        repId: counselor ? counselor._id : repId,
        repName: counselor ? counselor.name : assignedTo.repName || 'Admissions Counselor',
        repRole: counselor ? (counselor.title || 'Admissions Counselor') : 'Admissions Counselor',
        assignedAt: new Date(),
      }
      leadGroupId = counselor?.groupId || groupId || null
    } else {
      // Automatic capacity-aware round-robin assignment
      const allocation = await allocateLead(formId)
      leadAssignmentStatus = allocation.assignmentStatus || 'ASSIGNED'
      leadAssignedTo = allocation.assignedTo || null
      leadGroupId = allocation.groupId || null
    }

    const cleanProgram = courseProgram || 'Healthcare Management'
    const cleanVariant = cleanProgram === 'Healthcare Management' ? (courseVariant || '') : ''

    const newLead = new Lead({
      metaLeadId: `manual_${Date.now()}`,
      fullName: nameVal,
      phone: sanitizePhone(phone || ''),
      email: (email || '').toLowerCase().trim(),
      qualification: qualification || 'Degree',
      age: age ? Number(age) : null,
      state: state || 'Kerala',
      otherState: state === 'Other' ? (otherState || '') : '',
      district: state === 'Kerala' ? (district || 'Ernakulam') : 'Other',
      courseProgram: cleanProgram,
      courseVariant: cleanVariant,
      customerCategory: customerCategory || 'Ongoing Student',

      preferredLocation: state === 'Kerala' ? (district || 'Kerala') : (otherState || 'Outside Kerala'),
      learningMode: 'Flexible',
      careerRole: 'Hospital Administration',
      platform: 'Manual Entry',
      campaignName: 'Direct Admission / Manual Typing',
      adsetName: 'Inbound Enquiry',
      adName: 'Manual Entry',
      formName: 'Manual Admission Form',
      createdTime: new Date(),

      assignmentStatus: leadAssignmentStatus,
      assignedTo: leadAssignedTo,
      groupId: leadGroupId,

      status: status || 'Not Contacted',
      subStatus: subStatus || (leadAssignmentStatus === 'ASSIGNED' ? 'Assigned to Counselor' : 'New Lead In Pool'),
      callAttempts: 0,
      callbackAt: null,
      isDropped: false,
      isCompleted: false,

      notes: [
        {
          text: leadAssignedTo
            ? `Lead manually added and assigned directly to ${leadAssignedTo.repName}`
            : 'Lead manually added to system pool',
          author: author || 'Admin',
          status: status || 'Not Contacted',
          subStatus: subStatus || (leadAssignmentStatus === 'ASSIGNED' ? 'Assigned to Counselor' : 'New Lead In Pool'),
          timestamp: new Date(),
        },
      ],
    })

    const saved = await newLead.save()
    res.status(201).json({
      success: true,
      message: `Lead for ${saved.fullName} created successfully`,
      lead: { ...saved.toObject(), id: saved._id.toString() },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PUT /api/leads/:id/profile (Admin or Counselor Edit Profile)
// -------------------------------------------------------------
export const updateLeadProfile = async (req, res) => {
  try {
    const { id } = req.params
    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Student / Lead not found' })
    }

    const {
      fullName,
      phone,
      email,
      qualification,
      age,
      state,
      otherState,
      district,
      courseProgram,
      courseVariant,
      customerCategory,
      status,
      subStatus,
      isDropped,
      droppedReason,
      isCompleted,
      assignmentStatus,
      assignedTo,
      author,
    } = req.body

    if (fullName) lead.fullName = fullName.trim()
    if (phone !== undefined) lead.phone = sanitizePhone(phone)
    if (email !== undefined) lead.email = (email || '').toLowerCase().trim()
    if (qualification) lead.qualification = qualification
    if (age !== undefined) lead.age = age ? Number(age) : null
    if (state) lead.state = state
    if (otherState !== undefined) lead.otherState = otherState
    if (district !== undefined) lead.district = district
    if (courseProgram) {
      lead.courseProgram = courseProgram
      if (courseProgram !== 'Healthcare Management') {
        lead.courseVariant = ''
      } else if (courseVariant !== undefined) {
        lead.courseVariant = courseVariant
      }
    } else if (courseVariant !== undefined && lead.courseProgram === 'Healthcare Management') {
      lead.courseVariant = courseVariant
    }
    if (customerCategory) lead.customerCategory = customerCategory

    if (status) lead.status = status
    if (subStatus) lead.subStatus = subStatus

    // Lifecycle completion / dropped
    if (isCompleted !== undefined) {
      lead.isCompleted = Boolean(isCompleted)
      if (lead.isCompleted) {
        lead.isDropped = false
        lead.completedAt = lead.completedAt || new Date()
        lead.subStatus = lead.subStatus || 'Student Enrolled'
      }
    }
    if (isDropped !== undefined) {
      lead.isDropped = Boolean(isDropped)
      if (lead.isDropped) {
        lead.isCompleted = false
        lead.droppedReason = droppedReason || 'Lead Dropped / Lost'
        lead.subStatus = lead.subStatus || 'Dropped'
      }
    }

    // Assignment updates (e.g. moving back to system pool via manual data editing)
    if (assignmentStatus === 'UNASSIGNED') {
      lead.assignmentStatus = 'UNASSIGNED'
      lead.assignedTo = null
    } else if (assignedTo && (assignedTo.repId || assignedTo.id)) {
      const repId = assignedTo.repId || assignedTo.id
      const counselor = await User.findById(repId)
      lead.assignmentStatus = 'ASSIGNED'
      lead.assignedTo = {
        repId: counselor ? counselor._id : repId,
        repName: counselor ? counselor.name : assignedTo.repName,
        repRole: counselor ? (counselor.title || 'Admissions Counselor') : 'Admissions Counselor',
        assignedAt: new Date(),
      }
      lead.groupId = counselor?.groupId || lead.groupId
    }

    lead.notes.unshift({
      text: `Student profile updated: ${lead.fullName} (${lead.courseProgram}${lead.courseVariant ? ' - ' + lead.courseVariant : ''})`,
      author: author || 'Counselor',
      status: lead.status,
      subStatus: lead.subStatus,
      timestamp: new Date(),
    })

    await lead.save()

    res.status(200).json({
      success: true,
      message: 'Student profile updated successfully',
      lead: { ...lead.toObject(), id: lead._id.toString() },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// DELETE /api/leads/:id
// -------------------------------------------------------------
export const deleteLead = async (req, res) => {
  try {
    const { id } = req.params
    const deleted = await Lead.findByIdAndDelete(id)
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    res.status(200).json({ success: true, message: 'Lead deleted successfully' })
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
