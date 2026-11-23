import mongoose from 'mongoose'
import User from '../models/User.js'
import Lead from '../models/Lead.js'
import { BUSINESS_STATUSES } from '../models/CrmSettings.js'

const TERMINAL_STATUSES = ['CONVERTED BUSINESS', 'ONBOARDED BUSINESS', 'NON PROSPECT', 'LOST']

let initialAdvisorBackfilled = false

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One-time lightweight backfill so existing assigned leads immediately retain initialAdvisor
 */
async function ensureInitialAdvisorBackfill() {
  if (initialAdvisorBackfilled) return
  try {
    const unbackfilledLeads = await Lead.find({
      'assignedTo.repId': { $exists: true, $ne: null },
      $or: [
        { initialAdvisor: { $exists: false } },
        { initialAdvisor: null },
        { 'initialAdvisor.repId': { $exists: false } },
        { 'initialAdvisor.repId': null },
      ],
    }).select('_id assignedTo').lean()

    if (unbackfilledLeads.length > 0) {
      const ops = unbackfilledLeads.map(l => ({
        updateOne: {
          filter: { _id: l._id },
          update: { $set: { initialAdvisor: l.assignedTo } },
        },
      }))
      await Lead.bulkWrite(ops)
    }
    initialAdvisorBackfilled = true
  } catch (err) {
    console.warn('[ensureInitialAdvisorBackfill] warning:', err.message)
  }
}

/**
 * Generate 2-letter avatar initials from full name
 */
function generateAvatar(name) {
  if (!name) return 'SR'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function buildUserLeadHistoryQuery(userId) {
  const idStr = String(userId)
  const objId = mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : null
  const idVariants = objId ? [objId, idStr] : [idStr]
  return {
    $or: [
      { 'assignedTo.repId': { $in: idVariants } },
      { 'initialAdvisor.repId': { $in: idVariants } },
      { 'lastLostBy.repId': { $in: idVariants } },
      { 'steps.updatedBy.userId': idStr },
    ],
  }
}

// -------------------------------------------------------------
// GET /api/users - List users with real-time lead & historical analytics
// Supports ?status=active|disabled|all&role=sales|admin|all&search=&page=&limit=
// -------------------------------------------------------------
export const getAllUsers = async (req, res) => {
  try {
    await ensureInitialAdvisorBackfill()

    const { page, limit, status = 'all', role = 'all', search = '' } = req.query
    const isPaginated = page !== undefined || limit !== undefined
    const pageNum = Math.max(1, parseInt(page) || 1)
    const pageSize = Math.max(1, parseInt(limit) || 20)

    const filterConditions = []
    if (status === 'active') {
      filterConditions.push({ active: { $ne: false } })
    } else if (status === 'disabled' || status === 'inactive') {
      filterConditions.push({ active: false })
    }
    if (role === 'sales' || role === 'admin') {
      filterConditions.push({ role })
    }
    if (search && String(search).trim()) {
      const regex = new RegExp(escapeRegex(String(search).trim()), 'i')
      filterConditions.push({
        $or: [
          { name: regex },
          { email: regex },
          { title: regex },
          { specialty: regex },
        ],
      })
    }

    const listFilter = filterConditions.length > 0 ? { $and: filterConditions } : {}

    const [filteredTotal, totalAllUsers, activeAdvisorsCount, disabledCount] = await Promise.all([
      User.countDocuments(listFilter),
      User.countDocuments(),
      User.countDocuments({ role: 'sales', active: { $ne: false } }),
      User.countDocuments({ active: false }),
    ])

    let queryExec = User.find(listFilter).sort({ active: -1, role: 1, disabledAt: -1, createdAt: -1 })
    if (isPaginated) {
      queryExec = queryExec.skip((pageNum - 1) * pageSize).limit(pageSize)
    }
    const users = await queryExec.lean()

    const usersWithStats = await Promise.all(
      users.map(async u => {
        const userId = u._id
        const idStr = userId.toString()
        const assignedQuery = {
          $or: [{ 'assignedTo.repId': userId }, { 'assignedTo.repId': idStr }],
        }
        const historyQuery = buildUserLeadHistoryQuery(userId)

        const [
          totalAssigned,
          openAssignedCount,
          historicalLeadsCount,
          initialAdvisorCount,
          contactedCount,
          enrolledCount,
          completedCount,
          droppedCount,
        ] = await Promise.all([
          Lead.countDocuments(assignedQuery),
          Lead.countDocuments({
            ...assignedQuery,
            leadStatus: { $nin: TERMINAL_STATUSES },
            isCompleted: { $ne: true },
            isCycleEnded: { $ne: true },
          }),
          Lead.countDocuments(historyQuery),
          Lead.countDocuments({
            $or: [{ 'initialAdvisor.repId': userId }, { 'initialAdvisor.repId': idStr }],
          }),
          Lead.countDocuments({ ...assignedQuery, status: 'Contacted' }),
          Lead.countDocuments({
            ...assignedQuery,
            $or: [
              { leadStatus: { $in: ['CONVERTED BUSINESS', 'ONBOARDED BUSINESS'] } },
              { subStatus: /enrolled|won|admitted/i },
            ],
          }),
          Lead.countDocuments({ ...assignedQuery, isCompleted: true }),
          Lead.countDocuments({ ...assignedQuery, isDropped: true }),
        ])

        const contactRate = totalAssigned > 0 ? Math.round((contactedCount / totalAssigned) * 100) : 0

        return {
          id: idStr,
          _id: idStr,
          name: u.name,
          email: u.email,
          role: u.role,
          title: u.title || (u.role === 'admin' ? 'Administrator' : 'Admissions Counselor'),
          specialty: u.specialty || 'Healthcare Admissions',
          avatar: u.avatar || generateAvatar(u.name),
          active: u.active !== false,
          disabledAt: u.disabledAt || null,
          groupId: u.groupId || null,
          isGroupManager: Boolean(u.isGroupManager),
          totalAssigned,
          openAssignedCount,
          activeCount: openAssignedCount,
          historicalLeadsCount,
          initialAdvisorCount,
          completedCount,
          droppedCount,
          contactedCount,
          enrolledCount,
          contactRate,
          createdAt: u.createdAt,
        }
      })
    )

    res.status(200).json({
      success: true,
      users: usersWithStats,
      totalCount: filteredTotal,
      totalAllUsers,
      disabledCount,
      page: isPaginated ? pageNum : 1,
      limit: isPaginated ? pageSize : filteredTotal,
      totalPages: isPaginated ? Math.max(1, Math.ceil(filteredTotal / pageSize)) : 1,
      activeAdvisorsCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/users/:id/history - Detailed profile & paginated allocated lead history + activities
// -------------------------------------------------------------
export const getUserHistory = async (req, res) => {
  try {
    await ensureInitialAdvisorBackfill()

    const { id } = req.params
    const { page = 1, limit = 20, search = '' } = req.query

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' })
    }

    const user = await User.findById(id).lean()
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff member not found' })
    }

    const idStr = user._id.toString()
    const baseHistoryQuery = buildUserLeadHistoryQuery(user._id)

    // Summary metrics across ALL leads ever tied to this advisor (never paginated)
    const allHistoryLeads = await Lead.find(baseHistoryQuery)
      .select(
        'assignedTo initialAdvisor leadStatus courseFees paidAmount steps isCompleted isCycleEnded lostCycleCount'
      )
      .lean()

    let currentlyAssigned = 0
    let initialAdvisorCount = 0
    let convertedCount = 0
    let onboardedCount = 0
    let lostCount = 0
    let totalStepsLogged = 0
    let totalBusinessValue = 0
    let totalPaidAmount = 0

    for (const l of allHistoryLeads) {
      const isCurrent = l.assignedTo?.repId && String(l.assignedTo.repId) === idStr
      const isInitial = l.initialAdvisor?.repId && String(l.initialAdvisor.repId) === idStr
      if (isCurrent) currentlyAssigned++
      if (isInitial) initialAdvisorCount++
      if (l.leadStatus === 'CONVERTED BUSINESS') convertedCount++
      if (l.leadStatus === 'ONBOARDED BUSINESS') onboardedCount++
      if (l.leadStatus === 'LOST') lostCount++
      if (BUSINESS_STATUSES.includes(l.leadStatus)) {
        totalBusinessValue += Number(l.courseFees) || 0
        totalPaidAmount += Number(l.paidAmount) || 0
      }
      if (Array.isArray(l.steps)) {
        totalStepsLogged += l.steps.filter(s => String(s.updatedBy?.userId || '') === idStr).length
      }
    }

    // Filtered & backend-paginated leads list
    const andConditions = [baseHistoryQuery]
    if (search && String(search).trim()) {
      const trimmed = String(search).trim()
      const cleanId = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed
      const regex = new RegExp(escapeRegex(trimmed), 'i')
      const idRegex = cleanId ? new RegExp(escapeRegex(cleanId), 'i') : regex
      const orCond = [
        { fullName: regex },
        { phone: regex },
        { email: regex },
        { metaLeadId: idRegex },
        { courseProgram: regex },
        { courseVariant: regex },
        { leadStatus: regex },
      ]
      if (cleanId) {
        if (mongoose.Types.ObjectId.isValid(cleanId)) {
          orCond.push({ _id: new mongoose.Types.ObjectId(cleanId) })
        }
        orCond.push({
          $expr: {
            $regexMatch: {
              input: { $toString: '$_id' },
              regex: escapeRegex(cleanId),
              options: 'i',
            },
          },
        })
      }
      andConditions.push({ $or: orCond })
    }

    const finalFilter = andConditions.length === 1 ? andConditions[0] : { $and: andConditions }
    const pageNum = Math.max(1, parseInt(page) || 1)
    const pageSize = Math.max(1, Math.min(100, parseInt(limit) || 20))

    const [total, pagedLeads] = await Promise.all([
      Lead.countDocuments(finalFilter),
      Lead.find(finalFilter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((pageNum - 1) * pageSize)
        .limit(pageSize)
        .lean(),
    ])

    const formattedLeads = pagedLeads.map(l => {
      const isCurrent = l.assignedTo?.repId && String(l.assignedTo.repId) === idStr
      const isInitial = l.initialAdvisor?.repId && String(l.initialAdvisor.repId) === idStr
      let advisorRelation = 'Activity Logged'
      if (isCurrent && isInitial) advisorRelation = 'Initial & Current Advisor'
      else if (isInitial) advisorRelation = 'Initial Advisor (Reassigned)'
      else if (isCurrent) advisorRelation = 'Current Advisor'

      const repStepsCount = Array.isArray(l.steps)
        ? l.steps.filter(s => String(s.updatedBy?.userId || '') === idStr).length
        : 0

      return {
        ...l,
        id: l._id.toString(),
        leadStatus: l.leadStatus || 'NEW LEAD',
        advisorRelation,
        repStepsCount,
        totalStepsCount: Array.isArray(l.steps) ? l.steps.length : 0,
      }
    })

    res.status(200).json({
      success: true,
      user: {
        id: idStr,
        name: user.name,
        email: user.email,
        role: user.role,
        title: user.title || (user.role === 'admin' ? 'Administrator' : 'Admissions Counselor'),
        specialty: user.specialty || 'Healthcare Admissions',
        avatar: user.avatar || generateAvatar(user.name),
        active: user.active !== false,
        disabledAt: user.disabledAt || null,
        createdAt: user.createdAt,
      },
      summary: {
        totalAllocatedHistory: allHistoryLeads.length,
        currentlyAssigned,
        initialAdvisorCount,
        convertedCount,
        onboardedCount,
        lostCount,
        totalStepsLogged,
        totalBusinessValue,
        totalPaidAmount,
      },
      leads: formattedLeads,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/users - Create new sales advisor or admin
// -------------------------------------------------------------
export const createUser = async (req, res) => {
  try {
    const { name, email, password, role, title, specialty, active } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' })
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email address is required' })
    }

    const normalizedEmail = email.trim().toLowerCase()

    const existing = await User.findOne({ email: normalizedEmail })
    if (existing) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists' })
    }

    const assignedRole = role === 'admin' ? 'admin' : 'sales'
    const assignedTitle = title?.trim() || (assignedRole === 'admin' ? 'System Administrator' : 'Admissions Counselor')
    const assignedSpecialty = specialty?.trim() || 'Healthcare Admissions'
    const avatar = generateAvatar(name.trim())

    const newUser = new User({
      name: name.trim(),
      email: normalizedEmail,
      password: password && password.trim() ? password.trim() : 'password123',
      role: assignedRole,
      title: assignedTitle,
      specialty: assignedSpecialty,
      avatar,
      active: active !== false,
      disabledAt: active === false ? new Date() : null,
    })

    await newUser.save()

    res.status(201).json({
      success: true,
      message: `User ${newUser.name} created successfully as ${assignedRole === 'admin' ? 'Administrator' : 'Sales Advisor'}`,
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        title: newUser.title,
        specialty: newUser.specialty,
        avatar: newUser.avatar,
        active: newUser.active,
        disabledAt: newUser.disabledAt,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PUT /api/users/:id - Update existing user
// -------------------------------------------------------------
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params
    const { name, email, password, role, title, specialty, active, groupId, isGroupManager } = req.body

    const user = await User.findById(id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    // Administrator accounts cannot be disabled
    if (active === false && (user.role === 'admin' || role === 'admin')) {
      return res.status(403).json({
        success: false,
        message: 'Administrator accounts cannot be disabled.',
      })
    }

    if (groupId !== undefined) {
      user.groupId = groupId || null
    }

    if (isGroupManager !== undefined) {
      user.isGroupManager = Boolean(isGroupManager)
    }

    if (name && name.trim()) {
      user.name = name.trim()
      user.avatar = generateAvatar(user.name)
    }

    if (email && email.trim()) {
      const normalizedEmail = email.trim().toLowerCase()
      if (normalizedEmail !== user.email) {
        const existing = await User.findOne({ email: normalizedEmail, _id: { $ne: id } })
        if (existing) {
          return res.status(400).json({ success: false, message: 'Email address already in use by another user' })
        }
        user.email = normalizedEmail
      }
    }

    if (password && password.trim()) {
      user.password = password.trim()
    }

    if (role) {
      user.role = role === 'admin' ? 'admin' : 'sales'
    }

    if (title !== undefined) {
      user.title = title.trim()
    }

    if (specialty !== undefined) {
      user.specialty = specialty.trim()
    }

    if (active !== undefined) {
      const nextActive = Boolean(active)
      user.active = nextActive
      user.disabledAt = nextActive ? null : user.disabledAt || new Date()
    }

    await user.save()

    // If name or specialty updated, sync embedded advisor snapshots
    if (name || specialty) {
      const idVariants = [user._id, user._id.toString()]
      await Promise.all([
        Lead.updateMany(
          { 'assignedTo.repId': { $in: idVariants } },
          {
            $set: {
              'assignedTo.repName': user.name,
              'assignedTo.specialty': user.specialty,
            },
          }
        ),
        Lead.updateMany(
          { 'initialAdvisor.repId': { $in: idVariants } },
          {
            $set: {
              'initialAdvisor.repName': user.name,
            },
          }
        ),
      ])
    }

    res.status(200).json({
      success: true,
      message: `User ${user.name} updated successfully`,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        title: user.title,
        specialty: user.specialty,
        avatar: user.avatar,
        active: user.active,
        disabledAt: user.disabledAt,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PATCH /api/users/:id/disable - Disable or Re-enable staff safely without deleting any data
// Preserves initialAdvisor on all leads before optional handover of open leads
// -------------------------------------------------------------
export const disableOrEnableUser = async (req, res) => {
  try {
    await ensureInitialAdvisorBackfill()

    const { id } = req.params
    const { active = false, handoverMode = 'keep', targetRepId = '' } = req.body || {}

    const user = await User.findById(id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    const nextActive = Boolean(active)

    // Re-enable flow
    if (nextActive) {
      user.active = true
      user.disabledAt = null
      await user.save()
      return res.status(200).json({
        success: true,
        message: `${user.name} has been re-enabled and can log in again.`,
        user: {
          id: user._id.toString(),
          name: user.name,
          active: true,
          disabledAt: null,
        },
      })
    }

    // Administrator accounts cannot be disabled
    if (user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Administrator accounts cannot be disabled.',
      })
    }

    const idVariants = [user._id, user._id.toString()]
    const assignedQuery = { 'assignedTo.repId': { $in: idVariants } }

    // 1. Always lock initialAdvisor = this advisor on every assigned lead missing initialAdvisor
    const initialAdvisorPayload = {
      repId: user._id,
      repName: user.name,
      repRole: user.title || user.role || 'Admissions Counselor',
      assignedAt: user.createdAt || new Date(),
    }

    await Lead.updateMany(
      {
        ...assignedQuery,
        $or: [
          { initialAdvisor: { $exists: false } },
          { initialAdvisor: null },
          { 'initialAdvisor.repId': { $exists: false } },
          { 'initialAdvisor.repId': null },
        ],
      },
      {
        $set: {
          initialAdvisor: initialAdvisorPayload,
        },
      }
    )

    let handedOverCount = 0
    let handoverSummary = 'All leads remain archived under this advisor with full history intact.'

    // 2. Optional handover of ONLY open/non-terminal leads (never touches Converted/Onboarded/Lost/Non-Prospect)
    if (handoverMode === 'reassign_open') {
      const openLeadsQuery = {
        ...assignedQuery,
        leadStatus: { $nin: TERMINAL_STATUSES },
        isCompleted: { $ne: true },
        isCycleEnded: { $ne: true },
      }
      const now = new Date()

      if (targetRepId && targetRepId !== 'pool') {
        if (!mongoose.Types.ObjectId.isValid(targetRepId)) {
          return res.status(400).json({ success: false, message: 'Invalid target sales representative ID' })
        }
        const targetRep = await User.findById(targetRepId)
        if (!targetRep || targetRep.active === false) {
          return res.status(400).json({ success: false, message: 'Target counselor must be an active user.' })
        }
        if (String(targetRep._id) === String(user._id)) {
          return res.status(400).json({ success: false, message: 'Select a different active counselor for handover.' })
        }

        const updateRes = await Lead.updateMany(openLeadsQuery, {
          $set: {
            assignmentStatus: 'ASSIGNED',
            assignedTo: {
              repId: targetRep._id,
              repName: targetRep.name,
              repRole: targetRep.title || targetRep.role || 'Admissions Counselor',
              assignedAt: now,
            },
            groupId: targetRep.groupId || null,
            subStatus: `Handed over from ${user.name} (Disabled)`,
          },
          $push: {
            notes: {
              $each: [
                {
                  text: `Advisor ${user.name} was disabled. Open lead handed over to ${targetRep.name} (Initial Advisor preserved as ${user.name}).`,
                  author: req.user?.name || 'Admin System',
                  status: 'Not Contacted',
                  subStatus: `Handed over from ${user.name}`,
                  timestamp: now,
                },
              ],
              $position: 0,
            },
          },
        })
        handedOverCount = updateRes.modifiedCount || 0
        handoverSummary = `${handedOverCount} open lead(s) handed over to ${targetRep.name}; initial advisor preserved as ${user.name}.`
      } else {
        const updateRes = await Lead.updateMany(openLeadsQuery, {
          $set: {
            assignmentStatus: 'UNASSIGNED',
            assignedTo: null,
            groupId: null,
            subStatus: `Returned to Pool (${user.name} Disabled)`,
          },
          $push: {
            notes: {
              $each: [
                {
                  text: `Advisor ${user.name} was disabled. Open lead returned to System Pool (Initial Advisor preserved as ${user.name}).`,
                  author: req.user?.name || 'Admin System',
                  status: 'Not Contacted',
                  subStatus: 'Returned to Pool',
                  timestamp: now,
                },
              ],
              $position: 0,
            },
          },
        })
        handedOverCount = updateRes.modifiedCount || 0
        handoverSummary = `${handedOverCount} open lead(s) returned to System Pool; initial advisor preserved as ${user.name}.`
      }
    }

    user.active = false
    user.disabledAt = new Date()
    await user.save()

    res.status(200).json({
      success: true,
      message: `${user.name} has been disabled and can no longer log in. ${handoverSummary}`,
      handedOverCount,
      user: {
        id: user._id.toString(),
        name: user.name,
        active: false,
        disabledAt: user.disabledAt,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// DELETE /api/users/:id - Permanently disabled to protect lead history & attribution
// -------------------------------------------------------------
export const deleteUser = async (req, res) => {
  return res.status(403).json({
    success: false,
    message:
      'Removing staff accounts is disabled so lead history and initial advisor records are never lost. Use Disable Account instead.',
  })
}

// -------------------------------------------------------------
// PATCH /api/users/:id/pause - Pause or Resume Sales Counselor
// -------------------------------------------------------------
export const pauseOrResumeUser = async (req, res) => {
  try {
    const { id } = req.params
    const { isPaused, pauseStartDate, pauseEndDate, pauseReason } = req.body

    const user = await User.findById(id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    if (user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Admin accounts cannot be paused' })
    }

    const pausing = isPaused !== undefined ? Boolean(isPaused) : !user.isPaused

    user.isPaused = pausing
    if (pausing) {
      user.pauseStartDate = pauseStartDate ? new Date(pauseStartDate) : new Date()
      user.pauseEndDate = pauseEndDate ? new Date(pauseEndDate) : null
      user.pauseReason = pauseReason || ''
      user.pausedAt = new Date()
      user.pausedBy = req.user?._id || null
    } else {
      user.pauseStartDate = null
      user.pauseEndDate = null
      user.pauseReason = ''
      user.pausedAt = null
      user.pausedBy = null
    }

    await user.save()

    return res.status(200).json({
      success: true,
      message: pausing
        ? `${user.name} has been paused from round-robin allocation.${
            user.pauseEndDate
              ? ` Auto-resumes on ${new Date(user.pauseEndDate).toLocaleDateString()}`
              : ''
          }`
        : `${user.name} has resumed. Round-robin lead allocation is active.`,
      user: {
        id: user._id.toString(),
        name: user.name,
        isPaused: user.isPaused,
        pauseStartDate: user.pauseStartDate,
        pauseEndDate: user.pauseEndDate,
        pauseReason: user.pauseReason,
      },
    })
  } catch (error) {
    console.error('[pauseOrResumeUser] Error:', error)
    return res.status(500).json({ success: false, message: 'Failed to update pause status', error: error.message })
  }
}

