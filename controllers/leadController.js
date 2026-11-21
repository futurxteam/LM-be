import mongoose from 'mongoose'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import MetaIntegration from '../models/MetaIntegration.js'
import CourseProgram, { ensureDefaultPrograms } from '../models/CourseProgram.js'
import {
  getOrCreateCrmSettings,
  LEAD_STATUSES,
  BUSINESS_STATUSES,
  deriveHeatTierFromStatus,
} from '../models/CrmSettings.js'
import { isLeadAssignedToUser } from '../middleware/authMiddleware.js'
import { parseLeadsData, sanitizePhone } from '../utils/leadParser.js'
import { allocateLead } from '../services/allocationService.js'

/**
 * Strip Admin-only heatTier classification for non-admin callers
 */
function sanitizeLeadForRole(leadDoc, role) {
  const obj = typeof leadDoc.toObject === 'function' ? leadDoc.toObject() : { ...leadDoc }
  obj.id = obj._id ? obj._id.toString() : obj.id
  obj.leadStatus = obj.leadStatus || 'NEW LEAD'
  if (role !== 'admin') {
    delete obj.heatTier
    delete obj.lostCycleCount
    delete obj.canRecycle
    delete obj.cycleEndReason
    if (Array.isArray(obj.steps)) {
      obj.steps = obj.steps.map(s => {
        const copy = { ...s }
        delete copy.heatTier
        delete copy.cycleNumber
        return copy
      })
    }
  }
  return obj
}

/**
 * Count meaningful interactions logged in the lead's current cycle
 * (excludes system/admin recycle entries)
 */
function countCurrentCycleInteractions(lead) {
  const currentCycle = lead.cycleNumber || 1
  const steps = Array.isArray(lead.steps) ? lead.steps : []
  const cycleSteps = steps.filter(
    s =>
      (s.cycleNumber || 1) === currentCycle &&
      s.selectedCategory !== 'admin_recycled' &&
      s.selectedCategory !== 'auto_recycled'
  )
  if (cycleSteps.length > 0) return cycleSteps.length
  // Legacy fallback: only applies to cycle #1 leads created before steps[] existed
  if (currentCycle === 1 && (lead.callAttempts || 0) > 0) return lead.callAttempts
  return 0
}

/**
 * Capacity-aware Round-Robin counselor picker for Lost Recycling
 * Prefers active counselors other than excludeRepId when available
 */
async function pickRoundRobinCounselor(excludeRepId = null) {
  const allActiveReps = await User.find({ role: 'sales', active: { $ne: false } }).lean()
  if (allActiveReps.length === 0) return null

  const filtered = excludeRepId
    ? allActiveReps.filter(r => String(r._id) !== String(excludeRepId))
    : allActiveReps
  const pool = filtered.length > 0 ? filtered : allActiveReps

  const stats = await Promise.all(
    pool.map(async rep => {
      const activeCount = await Lead.countDocuments({
        $or: [
          { 'assignedTo.repId': rep._id },
          { 'assignedTo.repId': String(rep._id) },
        ],
        leadStatus: { $ne: 'LOST' },
        isDropped: { $ne: true },
        isCompleted: { $ne: true },
        isCycleEnded: { $ne: true },
      })
      return { rep, activeCount }
    })
  )

  stats.sort((a, b) => a.activeCount - b.activeCount)
  return stats[0]?.rep || null
}

/**
 * Core lifecycle transition & step logger shared across status/step/profile updates
 */
async function applyLifecycleUpdate(lead, payload, actor, settings) {
  const isAdmin = actor?.role === 'admin'
  const prevStatus = lead.leadStatus || 'NEW LEAD'

  const {
    categoryKey,
    leadStatus: requestedStatus,
    status: legacyStatus,
    subStatus: legacySubStatus,
    note,
    callbackAt,
    incrementCallAttempt,
    lostReason,
    businessProgramId,
    businessProgramName,
    businessProgramVariant,
    courseFees,
    paidAmount,
    adminException,
    author,
    isCompleted,
    isDropped,
    droppedReason,
  } = payload

  // Resolve outcome category & target status
  let matchedCategory = null
  if (categoryKey) {
    matchedCategory = (settings.outcomeCategories || []).find(
      c => c.key === String(categoryKey).trim() && c.active !== false
    )
    if (!matchedCategory) {
      return { error: `Unknown or inactive outcome category: "${categoryKey}"`, statusCode: 400 }
    }
  }

  let nextStatus = prevStatus
  if (matchedCategory) {
    nextStatus = matchedCategory.leadStatus
  } else if (requestedStatus && LEAD_STATUSES.includes(requestedStatus)) {
    nextStatus = requestedStatus
  }

  // Irreversible terminal-status guard for Sales Reps
  // LOST, CONVERTED BUSINESS, ONBOARDED BUSINESS, and NON PROSPECT cannot be reversed by Sales Reps
  // (Only forward progression CONVERTED BUSINESS -> ONBOARDED BUSINESS is allowed for Sales)
  const irreversibleForSales = ['LOST', 'NON PROSPECT', 'CONVERTED BUSINESS', 'ONBOARDED BUSINESS']
  if (!isAdmin && (lead.isCycleEnded || irreversibleForSales.includes(prevStatus))) {
    const isAllowedOnboardingProgress =
      prevStatus === 'CONVERTED BUSINESS' && nextStatus === 'ONBOARDED BUSINESS'
    if (!isAllowedOnboardingProgress) {
      return {
        error: 'This lead status cannot be reversed by a Sales Counselor. Contact an Administrator if changes are needed.',
        statusCode: 403,
      }
    }
  }

  // 1st-Interaction Unlock Gate: LOST, CONVERTED BUSINESS, and ONBOARDED BUSINESS unlock only after 1st interaction
  const requiresFirstInteraction = ['LOST', 'CONVERTED BUSINESS', 'ONBOARDED BUSINESS']
  if (!isAdmin && requiresFirstInteraction.includes(nextStatus) && countCurrentCycleInteractions(lead) === 0) {
    return {
      error: `${nextStatus} is locked until after the 1st interaction is logged for this lead.`,
      statusCode: 400,
    }
  }

  // Derive heatTier (server-side, Admin-only in responses)
  const nextHeatTier = matchedCategory
    ? matchedCategory.heatTier || deriveHeatTierFromStatus(nextStatus)
    : deriveHeatTierFromStatus(nextStatus)

  // Validate mandatory Lost Reason when transitioning to LOST
  const cleanLostReason = String(lostReason ?? droppedReason ?? '').trim()
  if (nextStatus === 'LOST' && !cleanLostReason && !lead.lostReason) {
    return {
      error: 'Lost Reason is mandatory when marking a lead as LOST.',
      statusCode: 400,
    }
  }

  // Check conditional Business / Financial fields for QUALIFIED / CONVERTED / ONBOARDED BUSINESS
  const isBusinessStatus = BUSINESS_STATUSES.includes(nextStatus)
  const hasFinancialPayload =
    businessProgramId !== undefined ||
    businessProgramName !== undefined ||
    businessProgramVariant !== undefined ||
    courseFees !== undefined ||
    paidAmount !== undefined

  const prevFinancial = {
    businessProgramName: lead.businessProgramName || '',
    businessProgramVariant: lead.businessProgramVariant || '',
    courseFees: lead.courseFees ?? null,
    paidAmount: lead.paidAmount ?? null,
  }

  // Permission check for editing already-saved financial values
  const alreadyHasFinancial =
    Boolean(lead.businessProgramName) || lead.courseFees !== null || lead.paidAmount !== null
  if (hasFinancialPayload && alreadyHasFinancial && !isAdmin && !settings.allowSalesFinancialEdit) {
    const changingExisting =
      (businessProgramName !== undefined && businessProgramName !== lead.businessProgramName) ||
      (courseFees !== undefined && Number(courseFees) !== Number(lead.courseFees)) ||
      (paidAmount !== undefined && Number(paidAmount) !== Number(lead.paidAmount))
    if (changingExisting) {
      return {
        error: 'Financial fields are locked after entry. Contact an Administrator to edit them.',
        statusCode: 403,
      }
    }
  }

  let resolvedProgram = null
  if (businessProgramId || businessProgramName) {
    await ensureDefaultPrograms()
    if (businessProgramId && mongoose.Types.ObjectId.isValid(businessProgramId)) {
      resolvedProgram = await CourseProgram.findById(businessProgramId)
    } else if (businessProgramName) {
      resolvedProgram = await CourseProgram.findOne({
        name: new RegExp(`^${String(businessProgramName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      })
    }
  }

  const nextProgramId = resolvedProgram ? resolvedProgram._id : lead.businessProgramId
  const nextProgramName = resolvedProgram
    ? resolvedProgram.name
    : businessProgramName !== undefined
    ? String(businessProgramName).trim()
    : lead.businessProgramName

  let nextProgramVariant =
    businessProgramVariant !== undefined
      ? String(businessProgramVariant).trim()
      : lead.businessProgramVariant || ''
  // Clear variant if program changed to one that does not support that variant
  if (resolvedProgram && Array.isArray(resolvedProgram.variants)) {
    if (resolvedProgram.variants.length === 0) {
      nextProgramVariant = ''
    } else if (nextProgramVariant && !resolvedProgram.variants.includes(nextProgramVariant)) {
      nextProgramVariant = ''
    }
  }

  const nextCourseFees =
    courseFees !== undefined && courseFees !== '' && courseFees !== null
      ? Number(courseFees)
      : lead.courseFees
  const nextPaidAmount =
    paidAmount !== undefined && paidAmount !== '' && paidAmount !== null
      ? Number(paidAmount)
      : lead.paidAmount

  if (isBusinessStatus) {
    const bypassAllowed =
      Boolean(adminException) && isAdmin && settings.allowAdminBusinessFieldException !== false
    const mustRequire = settings.requireBusinessFields !== false && !bypassAllowed

    if (mustRequire) {
      if (!nextProgramId || !nextProgramName) {
        return {
          error: 'Course Program (from approved Program Master) is mandatory for Business statuses.',
          statusCode: 400,
        }
      }
      if (nextCourseFees === null || nextCourseFees === undefined || Number.isNaN(nextCourseFees) || nextCourseFees <= 0) {
        return {
          error: 'Course Fees (applicable total course fee > 0) is mandatory for Business statuses.',
          statusCode: 400,
        }
      }
      if (nextPaidAmount === null || nextPaidAmount === undefined || Number.isNaN(nextPaidAmount) || nextPaidAmount < 0) {
        return {
          error: 'Paid Amount (total received >= 0) is mandatory for Business statuses.',
          statusCode: 400,
        }
      }
    }
  }

  // Apply financial values (NEVER clear previously stored financial values when moving backwards)
  if (resolvedProgram) {
    lead.businessProgramId = resolvedProgram._id
    lead.businessProgramName = resolvedProgram.name
    lead.businessProgramVariant = nextProgramVariant
  } else if (businessProgramVariant !== undefined && lead.businessProgramName) {
    lead.businessProgramVariant = nextProgramVariant
  }
  if (courseFees !== undefined && courseFees !== '' && courseFees !== null && !Number.isNaN(Number(courseFees))) {
    lead.courseFees = Number(courseFees)
  }
  if (paidAmount !== undefined && paidAmount !== '' && paidAmount !== null && !Number.isNaN(Number(paidAmount))) {
    lead.paidAmount = Number(paidAmount)
  }

  // Audit financial changes if any value changed
  const newFinancial = {
    businessProgramName: lead.businessProgramName || '',
    businessProgramVariant: lead.businessProgramVariant || '',
    courseFees: lead.courseFees ?? null,
    paidAmount: lead.paidAmount ?? null,
  }
  const financialChanged =
    prevFinancial.businessProgramName !== newFinancial.businessProgramName ||
    prevFinancial.businessProgramVariant !== newFinancial.businessProgramVariant ||
    prevFinancial.courseFees !== newFinancial.courseFees ||
    prevFinancial.paidAmount !== newFinancial.paidAmount

  const actorInfo = {
    userId: actor?.id || actor?._id || '',
    name: actor?.name || author || lead.assignedTo?.repName || 'Staff',
    role: actor?.role || 'sales',
  }

  if (financialChanged) {
    lead.financialHistory = lead.financialHistory || []
    lead.financialHistory.unshift({
      previousValues: prevFinancial,
      newValues: newFinancial,
      leadStatus: nextStatus,
      note: String(note || '').trim(),
      changedBy: actorInfo,
      changedAt: new Date(),
    })
  }

  // Update primary lifecycle fields
  lead.leadStatus = nextStatus
  if (matchedCategory) {
    lead.selectedCategory = matchedCategory.key
    lead.selectedCategoryLabel = matchedCategory.label
  }
  lead.heatTier = nextHeatTier

  // Sync legacy status / subStatus
  if (nextStatus === 'NEW LEAD' || nextStatus === 'NON-CONNECT') {
    lead.status = 'Not Contacted'
  } else if (legacyStatus && !matchedCategory && !requestedStatus) {
    lead.status = legacyStatus
  } else {
    lead.status = 'Contacted'
  }
  lead.subStatus = matchedCategory?.label || legacySubStatus || nextStatus

  if (callbackAt !== undefined) lead.callbackAt = callbackAt || null
  if (incrementCallAttempt) {
    lead.callAttempts = (lead.callAttempts || 0) + 1
  }

  // Cycle & End-of-Cycle State Machine
  let autoRecycled = false
  const maxLostCycles = settings.maxLostCycles || 3

  if (nextStatus === 'NON PROSPECT') {
    lead.isCycleEnded = true
    lead.cycleEndReason = 'NON_PROSPECT'
    lead.canRecycle = false
    lead.isDropped = true
    lead.isCompleted = false
  } else if (nextStatus === 'CONVERTED BUSINESS') {
    lead.isCycleEnded = true
    lead.cycleEndReason = 'CONVERTED'
    lead.canRecycle = false
    lead.isCompleted = true
    lead.isDropped = false
    lead.completedAt = lead.completedAt || new Date()
  } else if (nextStatus === 'ONBOARDED BUSINESS') {
    lead.isCycleEnded = true
    lead.cycleEndReason = 'ONBOARDED'
    lead.canRecycle = false
    lead.isCompleted = true
    lead.isDropped = false
    lead.completedAt = lead.completedAt || new Date()
  } else if (nextStatus === 'LOST') {
    lead.lostReason = cleanLostReason || lead.lostReason
    lead.droppedReason = lead.lostReason
    lead.lastLostBy = {
      repId: lead.assignedTo?.repId || actorInfo.userId || null,
      repName: lead.assignedTo?.repName || actorInfo.name || 'Counselor',
      lostAt: new Date(),
    }
    // Increment lostCycleCount when entering LOST from a non-LOST status
    if (prevStatus !== 'LOST') {
      lead.lostCycleCount = (lead.lostCycleCount || 0) + 1
    }
    lead.isDropped = true
    lead.isCompleted = false

    if (lead.lostCycleCount >= maxLostCycles) {
      lead.isCycleEnded = true
      lead.cycleEndReason = 'MAX_LOST_REACHED'
      lead.canRecycle = false
    } else {
      lead.isCycleEnded = false
      lead.cycleEndReason = null
      lead.canRecycle = true
      if (settings.lostRecycleMode === 'auto_pool') {
        autoRecycled = true
      }
    }
  } else if (nextStatus === 'NON-CONNECT') {
    // Keep NON-CONNECT distinct from LOST and still active
    lead.isCycleEnded = false
    lead.cycleEndReason = null
    lead.canRecycle = false
    lead.isDropped = false
    lead.isCompleted = false
  } else {
    // NEW LEAD, HOT, WARM, COLD, QUALIFIED BUSINESS -> active
    lead.isCycleEnded = false
    lead.cycleEndReason = null
    lead.canRecycle = false
    lead.isDropped = false
    lead.isCompleted = false
  }

  // Legacy boolean overrides if caller did not pass categoryKey / leadStatus
  if (!matchedCategory && !requestedStatus) {
    if (isCompleted !== undefined) {
      lead.isCompleted = Boolean(isCompleted)
      if (lead.isCompleted) {
        lead.isDropped = false
        lead.completedAt = lead.completedAt || new Date()
      }
    }
    if (isDropped !== undefined) {
      lead.isDropped = Boolean(isDropped)
      if (lead.isDropped) {
        lead.isCompleted = false
        lead.droppedReason = droppedReason || note || 'Lead dropped / lost'
      }
    }
  }

  // Append chronological Step record
  lead.steps = lead.steps || []
  const nextStepNumber = lead.steps.length + 1
  const stepNote = String(note || '').trim()
  lead.steps.push({
    stepNumber: nextStepNumber,
    cycleNumber: lead.cycleNumber || 1,
    previousStatus: prevStatus,
    newStatus: nextStatus,
    selectedCategory: lead.selectedCategory || '',
    selectedCategoryLabel: lead.selectedCategoryLabel || nextStatus,
    heatTier: nextHeatTier,
    note: stepNote || `Updated to ${lead.selectedCategoryLabel || nextStatus}`,
    lostReason: nextStatus === 'LOST' ? lead.lostReason : '',
    callbackAt: lead.callbackAt || null,
    businessSnapshot: {
      businessProgramId: lead.businessProgramId || null,
      businessProgramName: lead.businessProgramName || '',
      businessProgramVariant: lead.businessProgramVariant || '',
      courseFees: lead.courseFees ?? null,
      paidAmount: lead.paidAmount ?? null,
    },
    updatedBy: actorInfo,
    timestamp: new Date(),
  })

  // Also add to legacy notes feed
  lead.notes.unshift({
    text:
      stepNote ||
      `Step #${nextStepNumber}: ${prevStatus} → ${nextStatus}` +
        (lead.selectedCategoryLabel ? ` (${lead.selectedCategoryLabel})` : '') +
        (nextStatus === 'LOST' && lead.lostReason ? ` | Reason: ${lead.lostReason}` : ''),
    author: actorInfo.name,
    status: lead.status,
    subStatus: lead.subStatus,
    timestamp: new Date(),
  })

  // If Admin configured Auto-Recycle to System Pool on recyclable LOST
  if (autoRecycled) {
    lead.cycleNumber = (lead.cycleNumber || 1) + 1
    lead.leadStatus = 'NEW LEAD'
    lead.selectedCategory = ''
    lead.selectedCategoryLabel = ''
    lead.heatTier = null
    lead.status = 'Not Contacted'
    lead.subStatus = `Auto-Recycled to Pool (Cycle #${lead.cycleNumber})`
    lead.assignmentStatus = 'UNASSIGNED'
    lead.assignedTo = null
    lead.canRecycle = false
    lead.isDropped = false
    lead.steps.push({
      stepNumber: lead.steps.length + 1,
      cycleNumber: lead.cycleNumber,
      previousStatus: 'LOST',
      newStatus: 'NEW LEAD',
      selectedCategory: 'auto_recycled',
      selectedCategoryLabel: `Auto-Recycled to System Pool (Cycle #${lead.cycleNumber} of ${maxLostCycles})`,
      heatTier: null,
      note: `Automatically returned to System Pool (Lost cycle ${lead.lostCycleCount}/${maxLostCycles}).`,
      lostReason: lead.lostReason,
      callbackAt: null,
      businessSnapshot: {
        businessProgramId: lead.businessProgramId || null,
        businessProgramName: lead.businessProgramName || '',
        businessProgramVariant: lead.businessProgramVariant || '',
        courseFees: lead.courseFees ?? null,
        paidAmount: lead.paidAmount ?? null,
      },
      updatedBy: { userId: 'system', name: 'Auto-Recycle Policy', role: 'system' },
      timestamp: new Date(),
    })
  }

  return { lead, autoRecycled }
}

// -------------------------------------------------------------
// GET /api/leads (Supports backend pagination by 30)
// -------------------------------------------------------------
export const getLeads = async (req, res) => {
  try {
    const {
      role,
      repId,
      poolOnly,
      status,
      leadStatus,
      heatTier,
      recyclableOnly,
      qualification,
      search,
      page,
      limit,
    } = req.query

    const callerRole = req.user?.role || (role === 'admin' ? 'admin' : 'sales')
    const andConditions = []

    // Remove LOST leads from Sales Rep active queue & Team view (Admin sees them in Lost Business & Master list)
    if (callerRole !== 'admin') {
      andConditions.push({ leadStatus: { $ne: 'LOST' } })
    }

    if (poolOnly === 'true') {
      andConditions.push({ assignmentStatus: 'UNASSIGNED' })
    } else if (repId) {
      if (mongoose.Types.ObjectId.isValid(repId)) {
        const objId = new mongoose.Types.ObjectId(repId)
        andConditions.push({
          $or: [
            { 'assignedTo.repId': objId },
            { 'assignedTo.repId': repId },
          ],
        })
      } else {
        const matchedUser = await User.findOne({
          $or: [
            { email: new RegExp(repId, 'i') },
            { name: new RegExp(repId, 'i') },
            { role: 'sales' },
          ],
        })
        if (matchedUser) {
          andConditions.push({
            $or: [
              { 'assignedTo.repId': matchedUser._id },
              { 'assignedTo.repId': matchedUser._id.toString() },
            ],
          })
        } else {
          andConditions.push({ assignmentStatus: 'ASSIGNED' })
        }
      }
    } else if (role === 'sales') {
      andConditions.push({ assignmentStatus: 'ASSIGNED' })
    }

    if (status && status !== 'All') {
      if (status === 'Unassigned') {
        andConditions.push({ assignmentStatus: 'UNASSIGNED' })
      } else if (status === 'Assigned') {
        andConditions.push({ assignmentStatus: 'ASSIGNED' })
      } else if (['HOT', 'WARM', 'COLD'].includes(status) && callerRole === 'admin') {
        // Admin Hot/Warm/Cold filter includes all leads classified under that heat tier
        // (e.g., COLD includes COLD + NON-CONNECT + NON PROSPECT + LOST; HOT includes HOT + Business milestones)
        andConditions.push({
          $or: [{ leadStatus: status }, { heatTier: status }],
        })
      } else if (status === 'NEW LEAD') {
        andConditions.push({
          $or: [{ leadStatus: 'NEW LEAD' }, { leadStatus: { $exists: false } }, { leadStatus: null }],
        })
      } else if (LEAD_STATUSES.includes(status)) {
        andConditions.push({ leadStatus: status })
      } else {
        andConditions.push({ status })
      }
    }

    if (leadStatus && leadStatus !== 'All' && LEAD_STATUSES.includes(leadStatus)) {
      andConditions.push({ leadStatus })
    }

    // Heat tier filtering is strictly Admin-only
    if (heatTier && heatTier !== 'All' && callerRole === 'admin') {
      andConditions.push({ heatTier })
    }

    if (recyclableOnly === 'true') {
      andConditions.push({ leadStatus: 'LOST', canRecycle: true, isCycleEnded: { $ne: true } })
    }

    if (qualification && qualification !== 'All') {
      andConditions.push({ qualification: new RegExp(qualification, 'i') })
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i')
      andConditions.push({
        $or: [
          { fullName: regex },
          { phone: regex },
          { email: regex },
          { qualification: regex },
          { preferredLocation: regex },
          { campaignName: regex },
          { selectedCategoryLabel: regex },
          { businessProgramName: regex },
        ],
      })
    }

    const filter = andConditions.length > 0 ? { $and: andConditions } : {}

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
    const formatted = leads.map(l => sanitizeLeadForRole(l, callerRole))

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
// PATCH /api/leads/:id/status & POST /api/leads/:id/steps
// Only Admin or the assigned Sales Counselor may update status & add steps
// -------------------------------------------------------------
export const updateLeadStatus = async (req, res) => {
  try {
    const { id } = req.params
    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found in database' })
    }

    // Permission enforcement: Admin or Assigned Sales Counselor only
    const actor = req.user
    if (actor && actor.role !== 'admin' && !isLeadAssignedToUser(lead, actor)) {
      return res.status(403).json({
        success: false,
        message: 'You can only update status and add steps on leads assigned to you.',
      })
    }

    const settings = await getOrCreateCrmSettings()
    const result = await applyLifecycleUpdate(lead, req.body || {}, actor, settings)
    if (result.error) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.error,
      })
    }

    await lead.save()
    const formatted = sanitizeLeadForRole(lead, actor?.role || 'sales')

    res.status(200).json({
      success: true,
      autoRecycled: actor?.role === 'admin' ? result.autoRecycled || false : undefined,
      message:
        actor?.role === 'admin' && result.autoRecycled
          ? `Lead marked LOST and auto-recycled back to System Pool (Cycle #${lead.cycleNumber}).`
          : 'Lead step & status updated successfully',
      lead: formatted,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// Alias endpoint specifically for step-by-step updates
export const addLeadStep = updateLeadStatus

// -------------------------------------------------------------
// POST /api/leads/:id/recycle (Admin-only: Recycle a single LOST lead)
// Supports recycleMethod: 'pool' | 'specific' | 'round-robin', plus force override
// -------------------------------------------------------------
export const recycleLead = async (req, res) => {
  try {
    const { id } = req.params
    const { recycleMethod, targetRepId, note, force } = req.body || {}

    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    const settings = await getOrCreateCrmSettings()
    const maxLostCycles = settings.maxLostCycles || 3

    if (lead.leadStatus !== 'LOST') {
      return res.status(400).json({
        success: false,
        message: `Only LOST leads can be recycled (current status: ${lead.leadStatus}).`,
      })
    }

    if (lead.lostCycleCount >= maxLostCycles && !force) {
      return res.status(400).json({
        success: false,
        message: `Lead has reached the maximum allowed Lost cycles (${lead.lostCycleCount}/${maxLostCycles}). Enable Admin Override to force recycle.`,
      })
    }

    const method =
      recycleMethod ||
      (targetRepId && mongoose.Types.ObjectId.isValid(targetRepId) ? 'specific' : 'pool')

    let assignedRep = null
    if (method === 'specific' && targetRepId && mongoose.Types.ObjectId.isValid(targetRepId)) {
      assignedRep = await User.findById(targetRepId)
      if (!assignedRep) {
        return res.status(404).json({ success: false, message: 'Target counselor not found.' })
      }
    } else if (method === 'round-robin') {
      const prevRepId = lead.lastLostBy?.repId || lead.assignedTo?.repId || null
      assignedRep = await pickRoundRobinCounselor(prevRepId)
    }

    lead.cycleNumber = (lead.cycleNumber || 1) + 1
    lead.leadStatus = 'NEW LEAD'
    lead.selectedCategory = ''
    lead.selectedCategoryLabel = ''
    lead.heatTier = null
    lead.status = 'Not Contacted'
    lead.canRecycle = false
    lead.isDropped = false
    lead.isCompleted = false
    lead.isCycleEnded = false
    lead.cycleEndReason = null

    let destinationText = 'System Pool (Unassigned)'
    if (assignedRep) {
      lead.assignmentStatus = 'ASSIGNED'
      lead.assignedTo = {
        repId: assignedRep._id,
        repName: assignedRep.name,
        repRole: assignedRep.title || 'Admissions Counselor',
        assignedAt: new Date(),
      }
      lead.groupId = assignedRep.groupId || null
      lead.subStatus =
        method === 'round-robin'
          ? `Auto-Recycled (Round-Robin) to ${assignedRep.name} (Cycle #${lead.cycleNumber})`
          : `Recycled to ${assignedRep.name} (Cycle #${lead.cycleNumber})`
      destinationText = `${assignedRep.name}${method === 'round-robin' ? ' (Auto Round-Robin)' : ''}`
    } else {
      lead.assignmentStatus = 'UNASSIGNED'
      lead.assignedTo = null
      lead.subStatus = `Recycled to System Pool (Cycle #${lead.cycleNumber})`
    }

    const actorInfo = {
      userId: req.user?.id || '',
      name: req.user?.name || 'Admin',
      role: req.user?.role || 'admin',
    }

    lead.steps = lead.steps || []
    lead.steps.push({
      stepNumber: lead.steps.length + 1,
      cycleNumber: lead.cycleNumber,
      previousStatus: 'LOST',
      newStatus: 'NEW LEAD',
      selectedCategory: 'admin_recycled',
      selectedCategoryLabel: `${force ? 'Admin Override Recycle' : 'Recycled by Admin'} → ${destinationText} (Cycle #${lead.cycleNumber})`,
      heatTier: null,
      note:
        String(note || '').trim() ||
        `Recycled by ${actorInfo.name} into ${destinationText} (Cycle #${lead.cycleNumber}; previous lost count: ${lead.lostCycleCount}/${maxLostCycles}).`,
      lostReason: '',
      callbackAt: null,
      businessSnapshot: {
        businessProgramId: lead.businessProgramId || null,
        businessProgramName: lead.businessProgramName || '',
        businessProgramVariant: lead.businessProgramVariant || '',
        courseFees: lead.courseFees ?? null,
        paidAmount: lead.paidAmount ?? null,
      },
      updatedBy: actorInfo,
      timestamp: new Date(),
    })

    lead.notes.unshift({
      text: `♻️ Recycled by ${actorInfo.name} → ${destinationText} (Cycle #${lead.cycleNumber})`,
      author: actorInfo.name,
      status: lead.status,
      subStatus: lead.subStatus,
      timestamp: new Date(),
    })

    await lead.save()
    res.status(200).json({
      success: true,
      message: `Lead "${lead.fullName}" recycled into ${destinationText} (Cycle #${lead.cycleNumber}).`,
      lead: sanitizeLeadForRole(lead, 'admin'),
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/bulk-recycle (Admin-only: Bulk or Entire-List recycle of LOST leads)
// Supports recycleMethod: 'pool' | 'specific' | 'round-robin', applyToAll, scope ('recyclable' | 'max_lost'), force
// -------------------------------------------------------------
export const bulkRecycleLeads = async (req, res) => {
  try {
    const {
      leadIds = [],
      recycleMethod,
      targetRepId,
      note,
      force = false,
      applyToAll = false,
      scope = 'recyclable',
    } = req.body || {}

    const settings = await getOrCreateCrmSettings()
    const maxLostCycles = settings.maxLostCycles || 3

    const query = { leadStatus: 'LOST' }
    if (applyToAll) {
      if (scope === 'max_lost') {
        query.lostCycleCount = { $gte: maxLostCycles }
      } else {
        query.lostCycleCount = { $lt: maxLostCycles }
      }
    } else {
      const validIds = (Array.isArray(leadIds) ? leadIds : []).filter(id =>
        mongoose.Types.ObjectId.isValid(id)
      )
      if (validIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Select at least one lead to recycle.' })
      }
      query._id = { $in: validIds }
      if (!force && scope !== 'max_lost') {
        query.lostCycleCount = { $lt: maxLostCycles }
      }
    }

    const method =
      recycleMethod ||
      (targetRepId && mongoose.Types.ObjectId.isValid(targetRepId) ? 'specific' : 'pool')

    const specificRep =
      method === 'specific' && targetRepId && mongoose.Types.ObjectId.isValid(targetRepId)
        ? await User.findById(targetRepId)
        : null

    if (method === 'specific' && !specificRep) {
      return res.status(400).json({ success: false, message: 'Please select a valid target counselor.' })
    }

    const leads = await Lead.find(query)
    if (leads.length === 0) {
      return res.status(200).json({
        success: true,
        recycledCount: 0,
        message: 'No matching LOST leads found to recycle.',
      })
    }

    const actorInfo = {
      userId: req.user?.id || '',
      name: req.user?.name || 'Admin',
      role: req.user?.role || 'admin',
    }

    let recycledCount = 0
    for (const lead of leads) {
      let chosenRep = specificRep
      if (method === 'round-robin') {
        const prevRepId = lead.lastLostBy?.repId || lead.assignedTo?.repId || null
        chosenRep = await pickRoundRobinCounselor(prevRepId)
      }

      lead.cycleNumber = (lead.cycleNumber || 1) + 1
      lead.leadStatus = 'NEW LEAD'
      lead.selectedCategory = ''
      lead.selectedCategoryLabel = ''
      lead.heatTier = null
      lead.status = 'Not Contacted'
      lead.canRecycle = false
      lead.isDropped = false
      lead.isCompleted = false
      lead.isCycleEnded = false
      lead.cycleEndReason = null

      let destText = 'System Pool'
      if (chosenRep) {
        lead.assignmentStatus = 'ASSIGNED'
        lead.assignedTo = {
          repId: chosenRep._id,
          repName: chosenRep.name,
          repRole: chosenRep.title || 'Admissions Counselor',
          assignedAt: new Date(),
        }
        lead.groupId = chosenRep.groupId || null
        lead.subStatus =
          method === 'round-robin'
            ? `Auto-Recycled (Round-Robin) to ${chosenRep.name} (Cycle #${lead.cycleNumber})`
            : `Recycled to ${chosenRep.name} (Cycle #${lead.cycleNumber})`
        destText = `${chosenRep.name}${method === 'round-robin' ? ' (Round-Robin)' : ''}`
      } else {
        lead.assignmentStatus = 'UNASSIGNED'
        lead.assignedTo = null
        lead.subStatus = `Recycled to System Pool (Cycle #${lead.cycleNumber})`
      }

      lead.steps = lead.steps || []
      lead.steps.push({
        stepNumber: lead.steps.length + 1,
        cycleNumber: lead.cycleNumber,
        previousStatus: 'LOST',
        newStatus: 'NEW LEAD',
        selectedCategory: 'admin_recycled',
        selectedCategoryLabel: `${force || scope === 'max_lost' ? 'Admin Override Recycle' : 'Bulk Recycled by Admin'} → ${destText} (Cycle #${lead.cycleNumber})`,
        heatTier: null,
        note: String(note || '').trim() || `Recycled by ${actorInfo.name} → ${destText} (Cycle #${lead.cycleNumber}).`,
        lostReason: '',
        callbackAt: null,
        businessSnapshot: {
          businessProgramId: lead.businessProgramId || null,
          businessProgramName: lead.businessProgramName || '',
          businessProgramVariant: lead.businessProgramVariant || '',
          courseFees: lead.courseFees ?? null,
          paidAmount: lead.paidAmount ?? null,
        },
        updatedBy: actorInfo,
        timestamp: new Date(),
      })

      await lead.save()
      recycledCount++
    }

    res.status(200).json({
      success: true,
      recycledCount,
      message: `Recycled ${recycledCount} LOST lead(s) (${method === 'round-robin' ? 'Auto Round-Robin' : method === 'specific' ? specificRep?.name : 'System Pool'}).`,
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

    const cleanState = String(state || '').trim()
    const cleanOtherState = cleanState === 'Other' ? String(otherState || '').trim() : ''
    const cleanDistrict = cleanState ? String(district || '').trim() : ''
    const resolvedLocation = cleanDistrict || cleanOtherState || cleanState || 'Not Specified'

    const newLead = new Lead({
      metaLeadId: `manual_${Date.now()}`,
      fullName: nameVal,
      phone: sanitizePhone(phone || ''),
      email: (email || '').toLowerCase().trim(),
      qualification: qualification || 'Degree',
      age: age ? Number(age) : null,
      state: cleanState,
      otherState: cleanOtherState,
      district: cleanDistrict,
      courseProgram: cleanProgram,
      courseVariant: cleanVariant,
      customerCategory: customerCategory || 'Ongoing Student',

      preferredLocation: resolvedLocation,
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

    // Permission check: Admin or Assigned Sales Counselor only
    const actor = req.user
    if (actor && actor.role !== 'admin' && !isLeadAssignedToUser(lead, actor)) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit profiles and statuses for leads assigned to you.',
      })
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
      categoryKey,
      leadStatus,
      status,
      subStatus,
      isDropped,
      droppedReason,
      lostReason,
      isCompleted,
      businessProgramId,
      businessProgramName,
      businessProgramVariant,
      courseFees,
      paidAmount,
      adminException,
      stepNote,
      callbackAt,
      assignmentStatus,
      assignedTo,
      author,
    } = req.body

    if (fullName) lead.fullName = fullName.trim()
    if (phone !== undefined) lead.phone = sanitizePhone(phone)
    if (email !== undefined) lead.email = (email || '').toLowerCase().trim()
    if (qualification) lead.qualification = qualification
    if (age !== undefined) lead.age = age ? Number(age) : null
    if (state !== undefined) lead.state = String(state || '').trim()
    if (otherState !== undefined) lead.otherState = String(otherState || '').trim()
    if (district !== undefined) lead.district = String(district || '').trim()

    // Keep preferredLocation synchronized whenever geography/demography is updated
    if (state !== undefined || otherState !== undefined || district !== undefined) {
      const effectiveDistrict = lead.district ? lead.district.trim() : ''
      const effectiveOtherState = lead.state === 'Other' ? (lead.otherState || '').trim() : ''
      const effectiveState = (lead.state || '').trim()
      const computedLoc =
        effectiveDistrict ||
        effectiveOtherState ||
        (effectiveState && effectiveState !== 'Other' ? effectiveState : '')
      if (computedLoc) {
        lead.preferredLocation = computedLoc
      } else if (!lead.preferredLocation || lead.preferredLocation === 'Not Specified') {
        lead.preferredLocation = 'Not Specified'
      }
    }
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

    // Apply lifecycle / business fields update if any lifecycle or financial field was passed
    const hasLifecycleUpdate =
      categoryKey !== undefined ||
      leadStatus !== undefined ||
      lostReason !== undefined ||
      businessProgramId !== undefined ||
      businessProgramName !== undefined ||
      courseFees !== undefined ||
      paidAmount !== undefined ||
      status !== undefined ||
      subStatus !== undefined ||
      isCompleted !== undefined ||
      isDropped !== undefined

    if (hasLifecycleUpdate) {
      const settings = await getOrCreateCrmSettings()
      const result = await applyLifecycleUpdate(
        lead,
        {
          categoryKey,
          leadStatus,
          status,
          subStatus,
          note: stepNote || `Profile & lifecycle updated (${lead.fullName})`,
          callbackAt,
          lostReason: lostReason ?? droppedReason,
          businessProgramId,
          businessProgramName,
          businessProgramVariant,
          courseFees,
          paidAmount,
          adminException,
          author,
          isCompleted,
          isDropped,
          droppedReason,
        },
        actor,
        settings
      )
      if (result.error) {
        return res.status(result.statusCode || 400).json({
          success: false,
          message: result.error,
        })
      }
    }

    // Assignment updates (Admin only can reassign or return to pool)
    if (!actor || actor.role === 'admin') {
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
    }

    if (!hasLifecycleUpdate) {
      lead.notes.unshift({
        text: `Student profile updated: ${lead.fullName} (${lead.courseProgram}${lead.courseVariant ? ' - ' + lead.courseVariant : ''})`,
        author: actor?.name || author || 'Counselor',
        status: lead.status,
        subStatus: lead.subStatus,
        timestamp: new Date(),
      })
    }

    await lead.save()

    res.status(200).json({
      success: true,
      message: 'Student profile updated successfully',
      lead: sanitizeLeadForRole(lead, actor?.role || 'sales'),
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
// POST /api/leads/bulk-delete (Remove multiple leads by _id, metaLeadId, or entire scope)
// -------------------------------------------------------------
export const bulkDeleteLeads = async (req, res) => {
  try {
    const { leadIds = [], metaLeadIds = [], applyToAll = false, scope } = req.body || {}

    if (applyToAll && scope) {
      const settings = await getOrCreateCrmSettings()
      const maxLostCycles = settings.maxLostCycles || 3
      let scopeFilter = null
      if (scope === 'max_lost') {
        scopeFilter = { leadStatus: 'LOST', lostCycleCount: { $gte: maxLostCycles } }
      } else if (scope === 'recyclable') {
        scopeFilter = { leadStatus: 'LOST', lostCycleCount: { $lt: maxLostCycles } }
      }
      if (!scopeFilter) {
        return res.status(400).json({ success: false, message: `Unsupported bulk-delete scope: "${scope}"` })
      }
      const result = await Lead.deleteMany(scopeFilter)
      return res.status(200).json({
        success: true,
        deletedCount: result.deletedCount,
        message: `Removed all ${result.deletedCount} lead(s) from ${scope === 'max_lost' ? 'Max-Limit Lost list' : 'Lost list'}.`,
      })
    }

    const validObjectIds = (Array.isArray(leadIds) ? leadIds : [])
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id))

    const cleanMetaIds = (Array.isArray(metaLeadIds) ? metaLeadIds : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)

    const orConditions = []
    if (validObjectIds.length > 0) {
      orConditions.push({ _id: { $in: validObjectIds } })
    }
    if (cleanMetaIds.length > 0) {
      orConditions.push({ metaLeadId: { $in: cleanMetaIds } })
    }

    if (orConditions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one valid leadId or metaLeadId to delete.',
      })
    }

    const result = await Lead.deleteMany({ $or: orConditions })
    res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: `Removed ${result.deletedCount} lead(s) from database.`,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/reset-db (Clean lead database - reseeding disabled)
// -------------------------------------------------------------
export const resetLeadDatabase = async (req, res) => {
  try {
    const { mode } = req.body

    if (mode && mode !== 'clean') {
      return res.status(400).json({
        success: false,
        message: 'Test/demo data reseeding is disabled.',
      })
    }

    const now = new Date()
    const deleteResult = await Lead.deleteMany({})
    await MetaIntegration.updateMany({}, {
      $set: {
        lastSuccessfulSyncAt: now,
        lastSyncMessage: 'Database cleaned: All leads wiped. Historical sync disabled to prevent resurrecting old submissions.',
      },
    })
    return res.status(200).json({
      success: true,
      message: `Database cleaned: Deleted ${deleteResult.deletedCount} leads. The database is now empty.`,
      deletedCount: deleteResult.deletedCount,
      leadsCount: 0,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
