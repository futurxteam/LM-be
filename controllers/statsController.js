import mongoose from 'mongoose'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import CounselorGroup from '../models/CounselorGroup.js'
import { wasCounselorPausedAt } from '../utils/counselorUtils.js'
import {
  getOrCreateCrmSettings,
  LEAD_STATUSES,
  BUSINESS_STATUSES,
  deriveHeatTierFromStatus,
} from '../models/CrmSettings.js'

export const getStats = async (req, res) => {
  try {
    // Keep poolCount only for the Assign Pool badge; all report figures & demographics use ASSIGNED leads only
    const assignedMatch = { assignmentStatus: 'ASSIGNED' }
    const poolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })
    const assignedCount = await Lead.countDocuments(assignedMatch)
    const totalLeads = assignedCount
    const contactedCount = await Lead.countDocuments({ ...assignedMatch, status: 'Contacted' })
    const notContactedCount = await Lead.countDocuments({ ...assignedMatch, status: 'Not Contacted' })
    const enrolledCount = await Lead.countDocuments({
      ...assignedMatch,
      $or: [
        { leadStatus: { $in: ['CONVERTED BUSINESS', 'ONBOARDED BUSINESS'] } },
        { subStatus: { $regex: /enrolled/i } },
      ],
    })

    const contactRate = assignedCount > 0 ? Math.round((contactedCount / assignedCount) * 100) : 0
    const conversionRate = assignedCount > 0 ? Math.round((enrolledCount / assignedCount) * 100) : 0

    // 1. Success Status Report (Assigned leads only — System Pool excluded from reports)
    const successStatusReport = [
      {
        status: 'Contacted (Engaged)',
        count: contactedCount,
        percentage: totalLeads > 0 ? Math.round((contactedCount / totalLeads) * 100) : 0,
        color: '#10b981',
        type: 'success',
      },
      {
        status: 'Enrolled / Won',
        count: enrolledCount,
        percentage: totalLeads > 0 ? Math.round((enrolledCount / totalLeads) * 100) : 0,
        color: '#059669',
        type: 'conversion',
      },
      {
        status: 'Not Contacted (Pending Outreach)',
        count: notContactedCount,
        percentage: totalLeads > 0 ? Math.round((notContactedCount / totalLeads) * 100) : 0,
        color: '#f59e0b',
        type: 'pending',
      },
    ]

    // 2. Current Stage Report (Assigned leads only)
    const stageAgg = await Lead.aggregate([
      { $match: assignedMatch },
      {
        $group: {
          _id: '$subStatus',
          count: { $sum: 1 },
          parentStatus: { $first: '$status' },
          assignmentStatus: { $first: '$assignmentStatus' },
          totalAttempts: { $sum: '$callAttempts' },
        },
      },
      { $sort: { count: -1 } },
    ])

    const stageReport = stageAgg.map(s => {
      const stageName = s._id || 'Unassigned / New'
      let stageCategory = 'In Progress'
      let stageColor = '#0284c7'

      if (stageName.includes('Enrolled') || stageName.includes('Won')) {
        stageCategory = 'Converted / Won'
        stageColor = '#059669'
      } else if (stageName.includes('Interested') || stageName.includes('Counseling') || stageName.includes('Brochure')) {
        stageCategory = 'High Intent Contacted'
        stageColor = '#10b981'
      } else if (stageName.includes('Ringing') || stageName.includes('Busy') || stageName.includes('Switched Off')) {
        stageCategory = 'Unreachable / Retry'
        stageColor = '#f59e0b'
      } else if (stageName.includes('Callback')) {
        stageCategory = 'Scheduled Follow-up'
        stageColor = '#ea580c'
      } else if (stageName.includes('Not Interested') || stageName.includes('Lost')) {
        stageCategory = 'Disqualified'
        stageColor = '#ef4444'
      } else if (stageName.includes('Pool')) {
        stageCategory = 'Ingested Pool'
        stageColor = '#8b5cf6'
      }

      return {
        stage: stageName,
        category: stageCategory,
        count: s.count,
        percentage: totalLeads > 0 ? Math.round((s.count / totalLeads) * 100) : 0,
        avgAttempts: s.count > 0 ? (s.totalAttempts / s.count).toFixed(1) : 0,
        color: stageColor,
      }
    })

    // 3. Reps Leaderboard directly from MongoDB
    const salesReps = await User.find({
      role: { $in: ['sales', 'manager'] },
      receiveLeads: { $ne: false },
    }).lean()
    const repsReport = await Promise.all(
      salesReps.map(async rep => {
        const repId = rep._id
        const repAssigned = await Lead.countDocuments({ 'assignedTo.repId': repId })
        const repContacted = await Lead.countDocuments({
          'assignedTo.repId': repId,
          status: 'Contacted',
        })
        const repNotContacted = await Lead.countDocuments({
          'assignedTo.repId': repId,
          status: 'Not Contacted',
        })
        const repEnrolled = await Lead.countDocuments({
          'assignedTo.repId': repId,
          subStatus: { $regex: /enrolled/i },
        })

        const attemptsAgg = await Lead.aggregate([
          { $match: { 'assignedTo.repId': repId } },
          { $group: { _id: null, totalAttempts: { $sum: '$callAttempts' } } },
        ])
        const totalAttempts = attemptsAgg[0]?.totalAttempts || 0
        const avgAttempts = repAssigned > 0 ? (totalAttempts / repAssigned).toFixed(1) : 0

        return {
          id: rep._id.toString(),
          name: rep.name,
          role: rep.title || rep.role,
          avatar: rep.avatar,
          specialty: rep.specialty,
          assignedCount: repAssigned,
          contactedCount: repContacted,
          notContactedCount: repNotContacted,
          enrolledCount: repEnrolled,
          contactRate: repAssigned > 0 ? Math.round((repContacted / repAssigned) * 100) : 0,
          avgCallAttempts: Number(avgAttempts),
        }
      })
    )

    // 4. Campaign Attribution Aggregation (Assigned leads only)
    const campaignAgg = await Lead.aggregate([
      { $match: assignedMatch },
      {
        $group: {
          _id: '$campaignName',
          total: { $sum: 1 },
          contacted: {
            $sum: { $cond: [{ $eq: ['$status', 'Contacted'] }, 1, 0] },
          },
          enrolled: {
            $sum: { $cond: [{ $regexMatch: { input: '$subStatus', regex: /enrolled/i } }, 1, 0] },
          },
        },
      },
      { $sort: { total: -1 } },
    ])

    const campaignReport = campaignAgg.map(c => ({
      name: c._id || 'General Meta Campaign',
      total: c.total,
      contacted: c.contacted,
      enrolled: c.enrolled,
      contactRate: c.total > 0 ? Math.round((c.contacted / c.total) * 100) : 0,
    }))

    // 5. Platform Split (Instagram vs Facebook - Assigned leads only)
    const platformAgg = await Lead.aggregate([
      { $match: assignedMatch },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    const platformReport = platformAgg.map(p => ({
      name: p._id || 'Meta Ads',
      count: p.count,
      percentage: totalLeads > 0 ? Math.round((p.count / totalLeads) * 100) : 0,
    }))

    // 6. Qualification Breakdown (Assigned leads only)
    const qualAgg = await Lead.aggregate([
      { $match: assignedMatch },
      { $group: { _id: '$qualification', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    const qualificationReport = qualAgg.map(q => ({
      name: q._id || 'Other',
      count: q.count,
      percentage: totalLeads > 0 ? Math.round((q.count / totalLeads) * 100) : 0,
    }))

    // 7. Preferred Location / Saved District & State Demography Breakdown (Assigned leads only)
    const locationAgg = await Lead.aggregate([
      { $match: assignedMatch },
      {
        $addFields: {
          effectiveLocation: {
            $let: {
              vars: {
                d: { $trim: { input: { $ifNull: ['$district', ''] } } },
                os: { $trim: { input: { $ifNull: ['$otherState', ''] } } },
                pl: { $trim: { input: { $ifNull: ['$preferredLocation', ''] } } },
                st: { $trim: { input: { $ifNull: ['$state', ''] } } },
              },
              in: {
                $cond: [
                  { $and: [{ $ne: ['$$d', ''] }, { $ne: ['$$d', 'Other'] }] },
                  '$$d',
                  {
                    $cond: [
                      { $ne: ['$$os', ''] },
                      '$$os',
                      {
                        $cond: [
                          { $and: [{ $ne: ['$$pl', ''] }, { $ne: ['$$pl', 'Not Specified'] }] },
                          '$$pl',
                          {
                            $cond: [
                              { $and: [{ $ne: ['$$st', ''] }, { $ne: ['$$st', 'Other'] }] },
                              '$$st',
                              'Not Specified',
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      {
        $group: {
          _id: {
            $cond: [
              {
                $regexMatch: {
                  input: '$effectiveLocation',
                  regex: /uae|dubai|abu dhabi|gcc|saudi/i,
                },
              },
              'UAE / GCC',
              {
                $cond: [
                  {
                    $regexMatch: {
                      input: '$effectiveLocation',
                      regex: /kochi|ernakulam|ekm/i,
                    },
                  },
                  'Kochi / Ernakulam',
                  '$effectiveLocation',
                ],
              },
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 15 },
    ])

    const locationReport = locationAgg.map(l => ({
      name: l._id || 'Not Specified',
      count: l.count,
      percentage: totalLeads > 0 ? Math.round((l.count / totalLeads) * 100) : 0,
    }))

    const businessAgg = await Lead.aggregate([
      { $match: { assignmentStatus: 'ASSIGNED', leadStatus: { $in: BUSINESS_STATUSES } } },
      {
        $group: {
          _id: null,
          qualifiedCount: { $sum: { $cond: [{ $eq: ['$leadStatus', 'QUALIFIED BUSINESS'] }, 1, 0] } },
          convertedCount: { $sum: { $cond: [{ $eq: ['$leadStatus', 'CONVERTED BUSINESS'] }, 1, 0] } },
          onboardedCount: { $sum: { $cond: [{ $eq: ['$leadStatus', 'ONBOARDED BUSINESS'] }, 1, 0] } },
          businessTurnover: { $sum: { $ifNull: ['$courseFees', 0] } },
          salesRevenue: { $sum: { $ifNull: ['$paidAmount', 0] } },
        },
      },
    ])
    const bizSummary = businessAgg[0] || {
      qualifiedCount: 0,
      convertedCount: 0,
      onboardedCount: 0,
      businessTurnover: 0,
      salesRevenue: 0,
    }

    res.status(200).json({
      success: true,
      totalLeads,
      poolCount,
      assignedCount,
      contactedCount,
      notContactedCount,
      enrolledCount,
      contactRate,
      conversionRate,
      qualifiedCount: bizSummary.qualifiedCount,
      convertedCount: bizSummary.convertedCount,
      onboardedCount: bizSummary.onboardedCount,
      businessTurnover: bizSummary.businessTurnover,
      salesRevenue: bizSummary.salesRevenue,
      successStatusReport,
      stageReport,
      repsReport,
      campaignReport,
      platformReport,
      qualificationReport,
      locationReport,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/stats/advanced (ADMIN-ONLY)
/**
 * Resolves report scope for Admin vs Group Manager.
 * - Admin: full org visibility (allowedRepIds: null, allowedGroupIds: null)
 * - Group Manager: scoped strictly to their managed group(s) and team members
 */
async function resolveManagerReportScope(reqUser) {
  const isAdmin = reqUser?.role === 'admin'
  const isManager = !isAdmin && (reqUser?.role === 'manager' || Boolean(reqUser?.isGroupManager))
  const callerId = String(reqUser?.id || reqUser?._id || '')

  if (isAdmin) {
    return { isAdmin: true, isManager: false, callerId, allowedRepIds: null, allowedGroupIds: null, managedGroups: [] }
  }

  if (isManager) {
    const allGroups = await CounselorGroup.find().populate('managerId', 'name email title').lean()
    const managedGroups = allGroups.filter(
      g =>
        (g.managerId && String(g.managerId._id || g.managerId) === callerId) ||
        (reqUser?.groupId && String(g._id) === String(reqUser.groupId))
    )
    const repSet = new Set([callerId])
    const groupIds = []
    for (const g of managedGroups) {
      groupIds.push(g._id.toString())
      if (g.managerId) repSet.add(String(g.managerId._id || g.managerId))
      for (const m of g.memberIds || []) {
        repSet.add(String(m._id || m))
      }
    }
    return {
      isAdmin: false,
      isManager: true,
      callerId,
      allowedRepIds: Array.from(repSet),
      allowedGroupIds: groupIds,
      managedGroups,
    }
  }

  return { isAdmin: false, isManager: false, callerId, allowedRepIds: [callerId], allowedGroupIds: [], managedGroups: [] }
}

function buildRepIdVariants(repIds = []) {
  const variants = []
  for (const rid of repIds) {
    variants.push(String(rid))
    if (mongoose.Types.ObjectId.isValid(rid)) variants.push(new mongoose.Types.ObjectId(rid))
  }
  return variants
}

// -------------------------------------------------------------
// GET /api/stats/advanced
// Hot / Warm / Cold Visual & Table Reports, 10-Status Lifecycle Funnel,
// Recyclable Lost Cycles, Business Value vs Paid Collection & Counselor Matrix
// -------------------------------------------------------------
export const getAdvancedReports = async (req, res) => {
  try {
    const scope = await resolveManagerReportScope(req.user)
    const {
      heatTier,
      leadStatus,
      repId,
      groupId,
      programName,
      fromDate,
      toDate,
      search,
      lostSearch,
      page,
      limit,
      recyclePage,
      recycleLimit,
      maxLostPage,
      maxLostLimit,
    } = req.query
    const settings = await getOrCreateCrmSettings()
    const maxLostCycles = settings.maxLostCycles || 3

    const heatPageNum = Math.max(1, parseInt(page) || 1)
    const heatPageSize = Math.max(1, parseInt(limit) || 30)
    const recPageNum = Math.max(1, parseInt(recyclePage) || 1)
    const recPageSize = Math.max(1, parseInt(recycleLimit) || 30)
    const maxLostPageNum = Math.max(1, parseInt(maxLostPage) || 1)
    const maxLostPageSize = Math.max(1, parseInt(maxLostLimit) || 30)

    // Exclude System Pool (UNASSIGNED) leads from all reports — System Pool appears only in Assign Pool tab
    const andConditions = [{ assignmentStatus: 'ASSIGNED' }]
    if (scope.allowedRepIds && scope.allowedRepIds.length > 0) {
      andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants(scope.allowedRepIds) } })
    }
    if (fromDate || toDate) {
      const dateFilter = {}
      if (fromDate) dateFilter.$gte = new Date(fromDate)
      if (toDate) {
        const end = new Date(toDate)
        end.setHours(23, 59, 59, 999)
        dateFilter.$lte = end
      }
      andConditions.push({ createdAt: dateFilter })
    }
    if (repId && repId !== 'All') {
      if (mongoose.Types.ObjectId.isValid(repId)) {
        andConditions.push({
          $or: [
            { 'assignedTo.repId': new mongoose.Types.ObjectId(repId) },
            { 'assignedTo.repId': repId },
          ],
        })
      } else {
        andConditions.push({ 'assignedTo.repId': repId })
      }
    }
    if (programName && programName !== 'All') {
      andConditions.push({
        $or: [
          { businessProgramName: programName },
          { courseProgram: programName },
        ],
      })
    }

    const baseFilter = andConditions.length > 0 ? { $and: andConditions } : {}
    const allLeads = await Lead.find(baseFilter).sort({ updatedAt: -1 }).lean()
    const total = allLeads.length

    // Normalize legacy leads on the fly so every lead has a valid leadStatus & heatTier
    const normalizedLeads = allLeads.map(l => {
      const statusVal = l.leadStatus || 'NEW LEAD'
      const heat = l.heatTier || deriveHeatTierFromStatus(statusVal)
      return {
        ...l,
        id: l._id.toString(),
        leadStatus: statusVal,
        heatTier: heat,
        cycleNumber: l.cycleNumber || 1,
        lostCycleCount: l.lostCycleCount || 0,
        stepsCount: Array.isArray(l.steps) ? l.steps.length : 0,
      }
    })

    // 1. Hot / Warm / Cold Summary & Category Breakdown (ADMIN-ONLY)
    const heatBuckets = {
      HOT: { tier: 'HOT', label: 'Hot Leads (Positive / Business)', count: 0, color: '#ef4444', bg: '#fef2f2', categories: {} },
      WARM: { tier: 'WARM', label: 'Warm Leads (Moderate / Follow-up)', count: 0, color: '#f59e0b', bg: '#fffbeb', categories: {} },
      COLD: { tier: 'COLD', label: 'Cold Leads (Low / Non-Connect / Non-Prospect / Lost)', count: 0, color: '#3b82f6', bg: '#eff6ff', categories: {} },
      UNCLASSIFIED: { tier: 'UNCLASSIFIED', label: 'Unclassified (New Leads)', count: 0, color: '#64748b', bg: '#f8fafc', categories: {} },
    }

    // 2. 10-Status Lifecycle Funnel
    const statusCounts = {}
    for (const s of LEAD_STATUSES) {
      statusCounts[s] = { status: s, count: 0, heatTier: deriveHeatTierFromStatus(s) }
    }

    // 3. Lost & Recycle Analytics
    let recyclableLostCount = 0
    let permanentlyLostCount = 0
    let recoveredFromLostCount = 0
    const lostReasonMap = {}
    const lostCycleDist = {}
    const recyclableLostLeads = []
    const maxLostLeads = []

    // 4. Financial Report (Business Value = courseFees vs Actual Collected = paidAmount)
    let totalBusinessValue = 0
    let totalPaidAmount = 0
    const milestoneFinance = {
      'QUALIFIED BUSINESS': { status: 'QUALIFIED BUSINESS', count: 0, businessValue: 0, paidAmount: 0 },
      'CONVERTED BUSINESS': { status: 'CONVERTED BUSINESS', count: 0, businessValue: 0, paidAmount: 0 },
      'ONBOARDED BUSINESS': { status: 'ONBOARDED BUSINESS', count: 0, businessValue: 0, paidAmount: 0 },
    }
    const programFinanceMap = {}
    const campaignFinanceMap = {}

    for (const lead of normalizedLeads) {
      const bucketKey = lead.heatTier && heatBuckets[lead.heatTier] ? lead.heatTier : 'UNCLASSIFIED'
      heatBuckets[bucketKey].count++
      const catLabel = lead.selectedCategoryLabel || lead.leadStatus || 'New Lead'
      heatBuckets[bucketKey].categories[catLabel] = (heatBuckets[bucketKey].categories[catLabel] || 0) + 1

      if (statusCounts[lead.leadStatus]) {
        statusCounts[lead.leadStatus].count++
      }

      // Lost cycle stats
      if (lead.lostCycleCount > 0) {
        const cycleKey = `Cycle ${lead.lostCycleCount}`
        lostCycleDist[cycleKey] = (lostCycleDist[cycleKey] || 0) + 1
        if (lead.leadStatus !== 'LOST') {
          recoveredFromLostCount++
        }
      }
      if (lead.leadStatus === 'LOST') {
        const reason = lead.lostReason || lead.droppedReason || 'Unspecified'
        lostReasonMap[reason] = (lostReasonMap[reason] || 0) + 1
        const lostRow = {
          id: lead.id,
          metaLeadId: lead.metaLeadId || '',
          fullName: lead.fullName,
          phone: lead.phone,
          email: lead.email,
          courseProgram: lead.courseProgram || lead.businessProgramName || '',
          courseVariant: lead.courseVariant || lead.businessProgramVariant || '',
          lostReason: reason,
          lostCycleCount: lead.lostCycleCount,
          maxLostCycles,
          cycleNumber: lead.cycleNumber,
          assignedTo: lead.assignedTo,
          lastLostBy: lead.lastLostBy || (lead.assignedTo?.repName ? { repId: lead.assignedTo.repId, repName: lead.assignedTo.repName, lostAt: lead.updatedAt } : null),
          updatedAt: lead.updatedAt,
          stepsCount: lead.stepsCount,
        }
        if (lead.lostCycleCount < maxLostCycles && !lead.isCycleEnded) {
          recyclableLostCount++
          recyclableLostLeads.push(lostRow)
        } else {
          permanentlyLostCount++
          maxLostLeads.push(lostRow)
        }
      }

      // Financial aggregation (for business statuses, or any lead with recorded financial value)
      const isBusiness = BUSINESS_STATUSES.includes(lead.leadStatus)
      const fees = Number(lead.courseFees) || 0
      const paid = Number(lead.paidAmount) || 0
      if (isBusiness) {
        totalBusinessValue += fees
        totalPaidAmount += paid
        milestoneFinance[lead.leadStatus].count++
        milestoneFinance[lead.leadStatus].businessValue += fees
        milestoneFinance[lead.leadStatus].paidAmount += paid

        const prog = lead.businessProgramName || lead.courseProgram || 'Unassigned Program'
        if (!programFinanceMap[prog]) {
          programFinanceMap[prog] = { program: prog, count: 0, businessValue: 0, paidAmount: 0 }
        }
        programFinanceMap[prog].count++
        programFinanceMap[prog].businessValue += fees
        programFinanceMap[prog].paidAmount += paid

        const camp = lead.campaignName || 'Direct / Manual'
        if (!campaignFinanceMap[camp]) {
          campaignFinanceMap[camp] = { campaign: camp, totalLeads: 0, businessCount: 0, businessValue: 0, paidAmount: 0 }
        }
        campaignFinanceMap[camp].businessCount++
        campaignFinanceMap[camp].businessValue += fees
        campaignFinanceMap[camp].paidAmount += paid
      }

      // Track total leads per campaign too
      const campName = lead.campaignName || 'Direct / Manual'
      if (!campaignFinanceMap[campName]) {
        campaignFinanceMap[campName] = { campaign: campName, totalLeads: 0, businessCount: 0, businessValue: 0, paidAmount: 0 }
      }
      campaignFinanceMap[campName].totalLeads++
    }

    const classifiedTotal = heatBuckets.HOT.count + heatBuckets.WARM.count + heatBuckets.COLD.count
    const heatSummary = ['HOT', 'WARM', 'COLD', 'UNCLASSIFIED'].map(k => {
      const b = heatBuckets[k]
      return {
        tier: b.tier,
        label: b.label,
        count: b.count,
        percentageOfAll: total > 0 ? Math.round((b.count / total) * 100) : 0,
        percentageOfClassified:
          k !== 'UNCLASSIFIED' && classifiedTotal > 0 ? Math.round((b.count / classifiedTotal) * 100) : 0,
        color: b.color,
        bg: b.bg,
        categoryBreakdown: Object.entries(b.categories)
          .map(([category, count]) => ({ category, count }))
          .sort((a, b2) => b2.count - a.count),
      }
    })

    const matchesLeadQuery = (row, rawQuery) => {
      const q = String(rawQuery || '').trim().toLowerCase()
      if (!q) return true
      const cleanId = q.startsWith('#') ? q.slice(1).trim() : q
      const idStr = String(row.id || row._id || '').toLowerCase()
      const metaIdStr = String(row.metaLeadId || '').toLowerCase()
      return (
        (row.fullName || '').toLowerCase().includes(q) ||
        (row.phone || '').toLowerCase().includes(q) ||
        (row.email || '').toLowerCase().includes(q) ||
        (cleanId && (idStr.includes(cleanId) || metaIdStr.includes(cleanId))) ||
        (row.courseProgram || '').toLowerCase().includes(q) ||
        (row.courseVariant || '').toLowerCase().includes(q) ||
        (row.selectedCategoryLabel || '').toLowerCase().includes(q) ||
        (row.assignedTo?.repName || '').toLowerCase().includes(q) ||
        (row.lastLostBy?.repName || '').toLowerCase().includes(q) ||
        (row.lostReason || '').toLowerCase().includes(q) ||
        (row.businessProgramName || '').toLowerCase().includes(q)
      )
    }

    // 5. Filterable Hot / Warm / Cold Table Rows
    let tableLeads = normalizedLeads
    if (heatTier && heatTier !== 'All') {
      tableLeads = tableLeads.filter(l => (l.heatTier || 'UNCLASSIFIED') === heatTier)
    }
    if (leadStatus && leadStatus !== 'All') {
      tableLeads = tableLeads.filter(l => l.leadStatus === leadStatus)
    }
    if (search && search.trim()) {
      tableLeads = tableLeads.filter(l => matchesLeadQuery(l, search))
    }

    const heatTableTotal = tableLeads.length
    const heatTableTotalPages = Math.max(1, Math.ceil(heatTableTotal / heatPageSize))
    const heatPagedLeads = tableLeads.slice(
      (heatPageNum - 1) * heatPageSize,
      heatPageNum * heatPageSize
    )

    const heatTableRows = heatPagedLeads.map(l => ({
      id: l.id,
      metaLeadId: l.metaLeadId || '',
      fullName: l.fullName,
      phone: l.phone,
      email: l.email,
      courseProgram: l.courseProgram || l.businessProgramName || '',
      courseVariant: l.courseVariant || l.businessProgramVariant || '',
      heatTier: l.heatTier || 'UNCLASSIFIED',
      leadStatus: l.leadStatus,
      selectedCategoryLabel: l.selectedCategoryLabel || l.subStatus || l.leadStatus,
      assignedRepName: l.assignedTo?.repName || 'Unassigned (Pool)',
      assignmentStatus: l.assignmentStatus,
      cycleNumber: l.cycleNumber,
      lostCycleCount: l.lostCycleCount,
      lostReason: l.lostReason || '',
      isCycleEnded: Boolean(l.isCycleEnded),
      canRecycle: Boolean(l.canRecycle),
      businessProgramName: l.businessProgramName || '',
      courseFees: l.courseFees ?? null,
      paidAmount: l.paidAmount ?? null,
      stepsCount: l.stepsCount,
      lastStepAt: l.steps?.length ? l.steps[l.steps.length - 1].timestamp : l.updatedAt,
      createdAt: l.createdAt,
    }))

    // Backend pagination + optional search for Recyclable Lost Leads & Max-Limit Lost Leads tables
    const filteredRecyclableLost =
      lostSearch && lostSearch.trim()
        ? recyclableLostLeads.filter(l => matchesLeadQuery(l, lostSearch))
        : recyclableLostLeads
    const recycleTotal = filteredRecyclableLost.length
    const recycleTotalPages = Math.max(1, Math.ceil(recycleTotal / recPageSize))
    const pagedRecyclableLeads = filteredRecyclableLost.slice(
      (recPageNum - 1) * recPageSize,
      recPageNum * recPageSize
    )

    const filteredMaxLost =
      lostSearch && lostSearch.trim()
        ? maxLostLeads.filter(l => matchesLeadQuery(l, lostSearch))
        : maxLostLeads
    const maxLostTotal = filteredMaxLost.length
    const maxLostTotalPages = Math.max(1, Math.ceil(maxLostTotal / maxLostPageSize))
    const pagedMaxLostLeads = filteredMaxLost.slice(
      (maxLostPageNum - 1) * maxLostPageSize,
      maxLostPageNum * maxLostPageSize
    )

    // 6. Counselor Performance Matrix (excludes Manage-Only Group Managers with receiveLeads: false)
    const [allSalesRepsRaw, allCounselorGroupsRaw] = await Promise.all([
      User.find({ role: { $in: ['sales', 'manager'] }, receiveLeads: { $ne: false } }).lean(),
      CounselorGroup.find().populate('managerId', 'name email title').lean(),
    ])
    const salesReps = scope.allowedRepIds
      ? allSalesRepsRaw.filter(r => scope.allowedRepIds.includes(r._id.toString()))
      : allSalesRepsRaw
    const counselorGroups = scope.allowedGroupIds
      ? allCounselorGroupsRaw.filter(g => scope.allowedGroupIds.includes(g._id.toString()))
      : allCounselorGroupsRaw
    const counselorMatrix = salesReps.map(rep => {
      const repIdStr = rep._id.toString()
      const repLeads = normalizedLeads.filter(
        l => l.assignedTo?.repId && String(l.assignedTo.repId) === repIdStr
      )
      const hot = repLeads.filter(l => l.heatTier === 'HOT').length
      const warm = repLeads.filter(l => l.heatTier === 'WARM').length
      const cold = repLeads.filter(l => l.heatTier === 'COLD').length
      const qualified = repLeads.filter(l => l.leadStatus === 'QUALIFIED BUSINESS').length
      const converted = repLeads.filter(l => l.leadStatus === 'CONVERTED BUSINESS').length
      const onboarded = repLeads.filter(l => l.leadStatus === 'ONBOARDED BUSINESS').length
      const nonProspect = repLeads.filter(l => l.leadStatus === 'NON PROSPECT').length
      const nonConnect = repLeads.filter(l => l.leadStatus === 'NON-CONNECT').length
      const lost = repLeads.filter(l => l.leadStatus === 'LOST').length
      const totalSteps = repLeads.reduce((sum, l) => sum + (l.stepsCount || 0), 0)
      const businessValue = repLeads
        .filter(l => BUSINESS_STATUSES.includes(l.leadStatus))
        .reduce((sum, l) => sum + (Number(l.courseFees) || 0), 0)
      const paidCollection = repLeads
        .filter(l => BUSINESS_STATUSES.includes(l.leadStatus))
        .reduce((sum, l) => sum + (Number(l.paidAmount) || 0), 0)

      return {
        id: repIdStr,
        name: rep.name,
        title: rep.title || 'Admissions Counselor',
        active: rep.active !== false,
        disabledAt: rep.disabledAt || null,
        totalAssigned: repLeads.length,
        hot,
        warm,
        cold,
        nonConnect,
        nonProspect,
        lost,
        qualified,
        converted,
        onboarded,
        totalSteps,
        businessValue,
        paidCollection,
        pendingBalance: Math.max(0, businessValue - paidCollection),
        conversionRate:
          repLeads.length > 0 ? Math.round(((converted + onboarded) / repLeads.length) * 100) : 0,
      }
    })

    // 7. Group-Wise Report (All CounselorGroups + Ungrouped Direct Counselors + System Pool)
    const groupedLeadIds = new Set()
    const buildGroupStats = (id, name, managerName, memberCount, groupLeads, isSystemBucket = false) => {
      const hot = groupLeads.filter(l => l.heatTier === 'HOT').length
      const warm = groupLeads.filter(l => l.heatTier === 'WARM').length
      const cold = groupLeads.filter(l => l.heatTier === 'COLD').length
      const newLeads = groupLeads.filter(l => l.leadStatus === 'NEW LEAD').length
      const nonConnect = groupLeads.filter(l => l.leadStatus === 'NON-CONNECT').length
      const nonProspect = groupLeads.filter(l => l.leadStatus === 'NON PROSPECT').length
      const lost = groupLeads.filter(l => l.leadStatus === 'LOST').length
      const qualified = groupLeads.filter(l => l.leadStatus === 'QUALIFIED BUSINESS').length
      const converted = groupLeads.filter(l => l.leadStatus === 'CONVERTED BUSINESS').length
      const onboarded = groupLeads.filter(l => l.leadStatus === 'ONBOARDED BUSINESS').length
      const totalSteps = groupLeads.reduce((sum, l) => sum + (l.stepsCount || 0), 0)
      const businessValue = groupLeads
        .filter(l => BUSINESS_STATUSES.includes(l.leadStatus))
        .reduce((sum, l) => sum + (Number(l.courseFees) || 0), 0)
      const paidCollection = groupLeads
        .filter(l => BUSINESS_STATUSES.includes(l.leadStatus))
        .reduce((sum, l) => sum + (Number(l.paidAmount) || 0), 0)

      return {
        id,
        groupName: name,
        managerName: managerName || '—',
        memberCount,
        isSystemBucket,
        totalLeads: groupLeads.length,
        newLeads,
        hot,
        warm,
        cold,
        nonConnect,
        nonProspect,
        lost,
        qualified,
        converted,
        onboarded,
        totalSteps,
        businessValue,
        paidCollection,
        pendingBalance: Math.max(0, businessValue - paidCollection),
        conversionRate:
          groupLeads.length > 0
            ? Math.round(((converted + onboarded) / groupLeads.length) * 100)
            : 0,
      }
    }

    const groupReport = counselorGroups.map(grp => {
      const grpIdStr = grp._id.toString()
      const memberSet = new Set((grp.memberIds || []).map(m => String(m)))
      if (grp.managerId?._id) memberSet.add(String(grp.managerId._id))

      const matched = normalizedLeads.filter(l => {
        const directGroupMatch = l.groupId && String(l.groupId) === grpIdStr
        const memberMatch = l.assignedTo?.repId && memberSet.has(String(l.assignedTo.repId))
        return directGroupMatch || memberMatch
      })
      matched.forEach(l => groupedLeadIds.add(l.id))

      return buildGroupStats(
        grpIdStr,
        grp.name,
        grp.managerId?.name || 'Unassigned',
        (grp.memberIds || []).length,
        matched,
        false
      )
    })

    const ungroupedAssigned = normalizedLeads.filter(
      l => l.assignmentStatus === 'ASSIGNED' && !groupedLeadIds.has(l.id)
    )
    if (ungroupedAssigned.length > 0) {
      groupReport.push(
        buildGroupStats('ungrouped', 'Ungrouped / Direct Counselors', '—', 0, ungroupedAssigned, true)
      )
    }

    res.status(200).json({
      success: true,
      policy: {
        maxLostCycles,
        lostRecycleMode: settings.lostRecycleMode,
        requireBusinessFields: settings.requireBusinessFields,
      },
      totals: {
        totalLeads: total,
        classifiedTotal,
        hotCount: heatBuckets.HOT.count,
        warmCount: heatBuckets.WARM.count,
        coldCount: heatBuckets.COLD.count,
        unclassifiedCount: heatBuckets.UNCLASSIFIED.count,
        cycleEndedCount: normalizedLeads.filter(l => l.isCycleEnded).length,
        activeCycleCount: normalizedLeads.filter(l => !l.isCycleEnded).length,
      },
      heatSummary,
      heatTableRows,
      heatPagination: {
        page: heatPageNum,
        limit: heatPageSize,
        total: heatTableTotal,
        totalPages: heatTableTotalPages,
      },
      lifecycleFunnel: LEAD_STATUSES.map(s => ({
        status: s,
        count: statusCounts[s].count,
        percentage: total > 0 ? Math.round((statusCounts[s].count / total) * 100) : 0,
        heatTier: statusCounts[s].heatTier,
      })),
      lostCycleReport: {
        maxLostCycles,
        recyclableCount: recyclableLostCount,
        permanentlyLostCount,
        recoveredFromLostCount,
        lostReasons: Object.entries(lostReasonMap)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
        cycleDistribution: Object.entries(lostCycleDist).map(([cycle, count]) => ({ cycle, count })),
        recyclableLeads: pagedRecyclableLeads,
        pagination: {
          page: recPageNum,
          limit: recPageSize,
          total: recycleTotal,
          totalPages: recycleTotalPages,
        },
        maxLostLeads: pagedMaxLostLeads,
        maxLostPagination: {
          page: maxLostPageNum,
          limit: maxLostPageSize,
          total: maxLostTotal,
          totalPages: maxLostTotalPages,
        },
      },
      financialReport: {
        totalBusinessValue,
        totalPaidAmount,
        totalPendingBalance: Math.max(0, totalBusinessValue - totalPaidAmount),
        collectionRate:
          totalBusinessValue > 0 ? Math.round((totalPaidAmount / totalBusinessValue) * 100) : 0,
        byMilestone: Object.values(milestoneFinance).map(m => ({
          ...m,
          pendingBalance: Math.max(0, m.businessValue - m.paidAmount),
        })),
        byProgram: Object.values(programFinanceMap)
          .map(p => ({ ...p, pendingBalance: Math.max(0, p.businessValue - p.paidAmount) }))
          .sort((a, b) => b.businessValue - a.businessValue),
        byCampaign: Object.values(campaignFinanceMap)
          .map(c => ({ ...c, pendingBalance: Math.max(0, c.businessValue - c.paidAmount) }))
          .sort((a, b) => b.businessValue - a.businessValue),
      },
      counselorMatrix,
      groupReport,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/stats/frd-reports (FRD Section 7: Business, Lead Conversion & Lead Status Reports)
// - Admin sees all counselors, teams, and Lead Status Report (HOT/WARM/COLD — Admin-Only)
// - Sales sees only their own (or managed team) Business Report (7.1) & Lead Conversion Report (7.2)
// -------------------------------------------------------------
export const getFrdReports = async (req, res) => {
  try {
    const scope = await resolveManagerReportScope(req.user)
    const isAdmin = scope.isAdmin
    const isManager = scope.isManager
    const hasFullReportTabs = isAdmin || isManager
    const callerId = scope.callerId
    const {
      period = 'till_date', // 'current_month' | 'till_date' | 'custom'
      fromDate = '',
      toDate = '',
      dateBasis = 'assignedAt', // 'assignedAt' | 'createdAt' | 'updatedAt'
      milestoneMode = 'current', // 'current' | 'ever_reached'
      repId = 'All',
      groupId = 'All',
      programName = 'All',
      source = 'All',
    } = req.query

    // Resolve date window
    let startDateObj = null
    let endDateObj = null
    if (period === 'current_month') {
      const now = new Date()
      startDateObj = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      endDateObj = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    } else if (period === 'custom' && (fromDate || toDate)) {
      if (fromDate) startDateObj = new Date(`${fromDate}T00:00:00.000`)
      if (toDate) endDateObj = new Date(`${toDate}T23:59:59.999`)
    }

    const [allSalesRepsRaw, allCounselorGroupsRaw] = await Promise.all([
      User.find({ role: { $in: ['sales', 'manager'] }, receiveLeads: { $ne: false } }).sort({ active: -1, name: 1 }).lean(),
      CounselorGroup.find().populate('managerId', 'name email').lean(),
    ])

    const allSalesReps = scope.allowedRepIds
      ? allSalesRepsRaw.filter(r => scope.allowedRepIds.includes(r._id.toString()))
      : allSalesRepsRaw
    const counselorGroups = scope.allowedGroupIds
      ? allCounselorGroupsRaw.filter(g => scope.allowedGroupIds.includes(g._id.toString()))
      : allCounselorGroupsRaw

    // Determine visible reps based on role
    let scopedRepIds = null
    if (isManager) {
      scopedRepIds = scope.allowedRepIds
      if (groupId && groupId !== 'All') {
        const grp = counselorGroups.find(g => String(g._id) === String(groupId))
        if (grp) {
          const set = new Set((grp.memberIds || []).map(m => String(m)))
          if (grp.managerId?._id) set.add(String(grp.managerId._id))
          scopedRepIds = Array.from(set)
        }
      }
    } else if (!isAdmin) {
      scopedRepIds = [callerId]
    } else if (groupId && groupId !== 'All') {
      const grp = counselorGroups.find(g => String(g._id) === String(groupId))
      if (grp) {
        const set = new Set((grp.memberIds || []).map(m => String(m)))
        if (grp.managerId?._id) set.add(String(grp.managerId._id))
        scopedRepIds = Array.from(set)
      }
    }

    // Never include System Pool (UNASSIGNED) leads outside Assign Pool tab
    const andConditions = [{ assignmentStatus: 'ASSIGNED' }]

    if (scopedRepIds && scopedRepIds.length > 0) {
      andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants(scopedRepIds) } })
    }

    if (hasFullReportTabs && repId && repId !== 'All') {
      if (mongoose.Types.ObjectId.isValid(repId)) {
        andConditions.push({
          $or: [
            { 'assignedTo.repId': new mongoose.Types.ObjectId(repId) },
            { 'assignedTo.repId': repId },
          ],
        })
      } else {
        andConditions.push({ 'assignedTo.repId': repId })
      }
    }

    if (programName && programName !== 'All') {
      andConditions.push({
        $or: [{ businessProgramName: programName }, { courseProgram: programName }],
      })
    }

    if (source && source !== 'All') {
      andConditions.push({
        $or: [{ platform: source }, { campaignName: source }],
      })
    }

    const rawAssignedLeads = await Lead.find(
      andConditions.length === 1 ? andConditions[0] : { $and: andConditions }
    )
      .select(
        'assignedTo initialAdvisor leadStatus heatTier courseProgram businessProgramName platform campaignName courseFees paidAmount overpaidFlag milestoneHistory steps createdAt updatedAt'
      )
      .lean()

    // Apply Date Basis filter cleanly (supports assignedTo.assignedAt with fallback to createdAt)
    const cohortLeads = rawAssignedLeads.filter(l => {
      if (!startDateObj && !endDateObj) return true
      let basisDate = l.createdAt
      if (dateBasis === 'assignedAt') {
        basisDate = l.assignedTo?.assignedAt || l.createdAt
      } else if (dateBasis === 'updatedAt') {
        basisDate = l.updatedAt || l.createdAt
      }
      const d = basisDate ? new Date(basisDate) : null
      if (!d || Number.isNaN(d.getTime())) return false
      if (startDateObj && d < startDateObj) return false
      if (endDateObj && d > endDateObj) return false
      return true
    })

    // Helper: check if lead reached a milestone (either current status or ever_reached)
    const hasReachedMilestone = (lead, targetStatus) => {
      const cur = lead.leadStatus || 'NEW LEAD'
      if (milestoneMode !== 'ever_reached') {
        return cur === targetStatus
      }
      if (cur === targetStatus) return true
      if (targetStatus === 'QUALIFIED BUSINESS' && lead.milestoneHistory?.qualifiedAt) return true
      if (targetStatus === 'CONVERTED BUSINESS' && lead.milestoneHistory?.convertedAt) return true
      if (targetStatus === 'ONBOARDED BUSINESS' && lead.milestoneHistory?.onboardedAt) return true
      if (Array.isArray(lead.steps) && lead.steps.some(s => s.newStatus === targetStatus)) return true
      return false
    }

    const roundPct = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : 0)

    // Determine rows of users to report on
    const visibleReps = allSalesReps.filter(rep => {
      const idStr = rep._id.toString()
      if (scopedRepIds && !scopedRepIds.includes(idStr)) return false
      if (hasFullReportTabs && repId && repId !== 'All' && String(repId) !== idStr) return false
      return true
    })

    const businessReport = []
    const conversionReport = []
    const statusReport = []

    const kpiTotals = {
      leadsAllocated: cohortLeads.length,
      aggregateBusinessCount: 0,
      aggregateTurnover: 0,
      aggregateSalesRevenue: 0,
      qualifiedCount: 0,
      qualifiedTurnover: 0,
      qualifiedRevenue: 0,
      convertedCount: 0,
      convertedTurnover: 0,
      convertedRevenue: 0,
      onboardedCount: 0,
      onboardedTurnover: 0,
      onboardedRevenue: 0,
      overpaidCount: 0,
    }

    for (const rep of visibleReps) {
      const repIdStr = rep._id.toString()
      const userLeads = cohortLeads.filter(
        l => l.assignedTo?.repId && String(l.assignedTo.repId) === repIdStr
      )
      const allocated = userLeads.length

      // Unique leads reaching ANY business milestone (counted ONCE per FRD 7.1 & 8)
      const aggBizLeads = userLeads.filter(
        l =>
          hasReachedMilestone(l, 'QUALIFIED BUSINESS') ||
          hasReachedMilestone(l, 'CONVERTED BUSINESS') ||
          hasReachedMilestone(l, 'ONBOARDED BUSINESS')
      )
      const aggCount = aggBizLeads.length
      const aggTurnover = aggBizLeads.reduce((s, l) => s + (Number(l.courseFees) || 0), 0)
      const aggRevenue = aggBizLeads.reduce((s, l) => s + (Number(l.paidAmount) || 0), 0)

      const qLeads = userLeads.filter(l => hasReachedMilestone(l, 'QUALIFIED BUSINESS'))
      const cLeads = userLeads.filter(l => hasReachedMilestone(l, 'CONVERTED BUSINESS'))
      const oLeads = userLeads.filter(l => hasReachedMilestone(l, 'ONBOARDED BUSINESS'))

      const sumFees = arr => arr.reduce((s, l) => s + (Number(l.courseFees) || 0), 0)
      const sumPaid = arr => arr.reduce((s, l) => s + (Number(l.paidAmount) || 0), 0)

      const qTurnover = sumFees(qLeads)
      const qRevenue = sumPaid(qLeads)
      const cTurnover = sumFees(cLeads)
      const cRevenue = sumPaid(cLeads)
      const oTurnover = sumFees(oLeads)
      const oRevenue = sumPaid(oLeads)

      kpiTotals.aggregateBusinessCount += aggCount
      kpiTotals.aggregateTurnover += aggTurnover
      kpiTotals.aggregateSalesRevenue += aggRevenue
      kpiTotals.qualifiedCount += qLeads.length
      kpiTotals.qualifiedTurnover += qTurnover
      kpiTotals.qualifiedRevenue += qRevenue
      kpiTotals.convertedCount += cLeads.length
      kpiTotals.convertedTurnover += cTurnover
      kpiTotals.convertedRevenue += cRevenue
      kpiTotals.onboardedCount += oLeads.length
      kpiTotals.onboardedTurnover += oTurnover
      kpiTotals.onboardedRevenue += oRevenue
      kpiTotals.overpaidCount += userLeads.filter(l => l.overpaidFlag).length

      businessReport.push({
        userId: repIdStr,
        userName: rep.name,
        title: rep.title || 'Admissions Counselor',
        active: rep.active !== false,
        leadsAllocated: allocated,
        aggregateCount: aggCount,
        aggregateTurnover: aggTurnover,
        aggregateSalesRevenue: aggRevenue,
        qualifiedCount: qLeads.length,
        qualifiedTurnover: qTurnover,
        qualifiedSalesRevenue: qRevenue,
        convertedCount: cLeads.length,
        convertedTurnover: cTurnover,
        convertedSalesRevenue: cRevenue,
        onboardedCount: oLeads.length,
        onboardedTurnover: oTurnover,
        onboardedSalesRevenue: oRevenue,
      })

      conversionReport.push({
        userId: repIdStr,
        userName: rep.name,
        title: rep.title || 'Admissions Counselor',
        active: rep.active !== false,
        leadsAllocated: allocated,
        aggregateCount: aggCount,
        aggregateRatio: roundPct(aggCount, allocated),
        qualifiedCount: qLeads.length,
        qualifiedRatio: roundPct(qLeads.length, allocated),
        convertedCount: cLeads.length,
        convertedRatio: roundPct(cLeads.length, allocated),
        onboardedCount: oLeads.length,
        onboardedRatio: roundPct(oLeads.length, allocated),
      })

      // FRD 7.3 Lead Status Report — Admin & Group Manager (group-scoped for Managers)
      if (hasFullReportTabs) {
        const countByStatus = st => userLeads.filter(l => (l.leadStatus || 'NEW LEAD') === st).length
        const hotCount = countByStatus('HOT')
        const warmCount = countByStatus('WARM')
        const coldCount = countByStatus('COLD')
        const lostCount = countByStatus('LOST')
        const nonConnectCount = countByStatus('NON-CONNECT')
        const nonProspectCount = countByStatus('NON PROSPECT')
        const otherCount = Math.max(
          0,
          allocated - (hotCount + warmCount + coldCount + lostCount + nonConnectCount + nonProspectCount)
        )

        statusReport.push({
          userId: repIdStr,
          userName: rep.name,
          title: rep.title || 'Admissions Counselor',
          active: rep.active !== false,
          leadsAllocated: allocated,
          hotCount,
          hotPct: roundPct(hotCount, allocated),
          warmCount,
          warmPct: roundPct(warmCount, allocated),
          coldCount,
          coldPct: roundPct(coldCount, allocated),
          lostCount,
          lostPct: roundPct(lostCount, allocated),
          nonConnectCount,
          nonConnectPct: roundPct(nonConnectCount, allocated),
          nonProspectCount,
          nonProspectPct: roundPct(nonProspectCount, allocated),
          otherCount,
          otherPct: roundPct(otherCount, allocated),
        })
      }
    }

    // Distinct filter dropdown values from live leads/programs
    const programSet = new Set()
    const sourceSet = new Set()
    rawAssignedLeads.forEach(l => {
      if (l.businessProgramName) programSet.add(l.businessProgramName)
      if (l.courseProgram) programSet.add(l.courseProgram)
      if (l.platform) sourceSet.add(l.platform)
    })

    res.status(200).json({
      success: true,
      meta: {
        period,
        dateBasis,
        milestoneMode,
        fromDate: startDateObj ? startDateObj.toISOString().slice(0, 10) : '',
        toDate: endDateObj ? endDateObj.toISOString().slice(0, 10) : '',
        isAdmin,
        isManager,
        hasFullReportTabs,
      },
      kpiTotals: {
        ...kpiTotals,
        pendingBalance: Math.max(0, kpiTotals.aggregateTurnover - kpiTotals.aggregateSalesRevenue),
        aggregateConversionRatio: roundPct(kpiTotals.aggregateBusinessCount, kpiTotals.leadsAllocated),
      },
      businessReport,
      conversionReport,
      statusReport: hasFullReportTabs ? statusReport : undefined,
      filterOptions: {
        counselors: allSalesReps.map(r => ({
          id: r._id.toString(),
          name: r.name,
          active: r.active !== false,
        })),
        teams: counselorGroups.map(g => ({
          id: g._id.toString(),
          name: g.name,
        })),
        programs: Array.from(programSet).sort(),
        sources: Array.from(sourceSet).sort(),
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/stats/discounts
// Discount Analytics Report (Admin: org-wide; Group Manager: group-scoped)
// Tracks discounts per month, by Sales Rep, by Group & Group Manager,
// by Who Set the Discount, and across Qualified / Converted / Onboarded statuses.
// -------------------------------------------------------------
export const getDiscountReport = async (req, res) => {
  try {
    const scope = await resolveManagerReportScope(req.user)
    const {
      period = 'till_date', // 'current_month' | 'last_month' | 'till_date' | 'custom'
      fromDate = '',
      toDate = '',
      status = 'All', // 'All' | 'QUALIFIED BUSINESS' | 'CONVERTED BUSINESS' | 'ONBOARDED BUSINESS'
      repId = 'All',
      groupId = 'All',
      programName = 'All',
    } = req.query

    // Resolve date window
    let startDateObj = null
    let endDateObj = null
    const now = new Date()
    if (period === 'current_month') {
      startDateObj = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      endDateObj = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    } else if (period === 'last_month') {
      startDateObj = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0)
      endDateObj = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    } else if (period === 'custom' && (fromDate || toDate)) {
      if (fromDate) startDateObj = new Date(`${fromDate}T00:00:00.000`)
      if (toDate) endDateObj = new Date(`${toDate}T23:59:59.999`)
    }

    const [allRepsRaw, allGroupsRaw] = await Promise.all([
      User.find({ role: { $in: ['sales', 'manager', 'admin'] } }).sort({ name: 1 }).lean(),
      CounselorGroup.find().populate('managerId', 'name email').lean(),
    ])

    const visibleReps = scope.allowedRepIds
      ? allRepsRaw.filter(r => scope.allowedRepIds.includes(r._id.toString()))
      : allRepsRaw.filter(r => r.role === 'sales' || r.role === 'manager')
    const visibleGroups = scope.allowedGroupIds
      ? allGroupsRaw.filter(g => scope.allowedGroupIds.includes(g._id.toString()))
      : allGroupsRaw

    // Map repId -> group info
    const repToGroupMap = new Map()
    for (const g of allGroupsRaw) {
      const gInfo = {
        groupId: g._id.toString(),
        groupName: g.name,
        managerId: g.managerId?._id?.toString() || (g.managerId ? String(g.managerId) : ''),
        managerName: g.managerId?.name || 'Unassigned Manager',
      }
      if (gInfo.managerId) repToGroupMap.set(gInfo.managerId, gInfo)
      for (const m of g.memberIds || []) {
        repToGroupMap.set(String(m._id || m), gInfo)
      }
    }

    // Build query for business leads with a discount
    const andConditions = [
      {
        leadStatus:
          status && status !== 'All'
            ? status
            : { $in: ['QUALIFIED BUSINESS', 'CONVERTED BUSINESS', 'ONBOARDED BUSINESS'] },
      },
      { discountAmount: { $gt: 0 } },
      { discountApprovalStatus: { $ne: 'PENDING' } },
    ]

    // Scope for Group Manager
    if (scope.allowedRepIds && scope.allowedRepIds.length > 0) {
      andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants(scope.allowedRepIds) } })
    }

    if (groupId && groupId !== 'All') {
      const grp = visibleGroups.find(g => g._id.toString() === String(groupId))
      if (grp) {
        const gRepIds = new Set((grp.memberIds || []).map(m => String(m._id || m)))
        if (grp.managerId) gRepIds.add(String(grp.managerId._id || grp.managerId))
        andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants(Array.from(gRepIds)) } })
      }
    }

    if (repId && repId !== 'All') {
      andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants([repId]) } })
    }

    if (programName && programName !== 'All') {
      andConditions.push({
        $or: [{ businessProgramName: programName }, { courseProgram: programName }],
      })
    }

    const rawLeads = await Lead.find({ $and: andConditions })
      .select(
        'fullName phone email leadStatus businessProgramName businessProgramVariant courseProgram courseFees agreedAmount discountAmount discountSetBy paidAmount assignedTo milestoneHistory updatedAt createdAt'
      )
      .sort({ updatedAt: -1 })
      .lean()

    // Filter by date window (using discountSetBy.setAt || qualifiedAt || convertedAt || updatedAt)
    const filteredLeads = rawLeads.filter(l => {
      const refDate = new Date(
        l.discountSetBy?.setAt ||
          l.milestoneHistory?.qualifiedAt ||
          l.milestoneHistory?.convertedAt ||
          l.updatedAt ||
          l.createdAt
      )
      if (startDateObj && refDate < startDateObj) return false
      if (endDateObj && refDate > endDateObj) return false
      return true
    })

    const roundPct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0)

    const kpiTotals = {
      totalDiscountedLeads: 0,
      totalStandardFees: 0,
      totalAgreedAmount: 0,
      totalDiscountGiven: 0,
      avgDiscountPercent: 0,
      qualifiedCount: 0,
      convertedCount: 0,
      onboardedCount: 0,
      qualifiedDiscount: 0,
      convertedDiscount: 0,
      onboardedDiscount: 0,
    }

    const monthlyMap = new Map()
    const repMap = new Map()
    const groupMap = new Map()
    const authorMap = new Map()
    const programSet = new Set()
    const leadRows = []

    for (const l of filteredLeads) {
      const stdFee = Number(l.courseFees) || 0
      const agreed = l.agreedAmount !== null && l.agreedAmount !== undefined ? Number(l.agreedAmount) : stdFee
      const discount = Number(l.discountAmount) || Math.max(0, stdFee - agreed)
      if (discount <= 0) continue

      const paid = Number(l.paidAmount) || 0
      const st = l.leadStatus || 'QUALIFIED BUSINESS'
      const prog = l.businessProgramName || l.courseProgram || 'Unspecified'
      programSet.add(prog)

      const repIdStr = l.assignedTo?.repId ? String(l.assignedTo.repId) : 'unassigned'
      const repName = l.assignedTo?.repName || 'Unassigned'
      const grp = repToGroupMap.get(repIdStr) || {
        groupId: 'ungrouped',
        groupName: 'Ungrouped',
        managerId: '',
        managerName: 'No Group Manager',
      }

      const setByName = l.discountSetBy?.name || repName || 'Staff'
      const setByRole = l.discountSetBy?.role || l.assignedTo?.repRole || 'sales'
      const setById = l.discountSetBy?.userId || repIdStr
      const discountDate = new Date(
        l.discountSetBy?.setAt ||
          l.milestoneHistory?.qualifiedAt ||
          l.milestoneHistory?.convertedAt ||
          l.updatedAt ||
          l.createdAt
      )
      const monthKey = `${discountDate.getFullYear()}-${String(discountDate.getMonth() + 1).padStart(2, '0')}`

      // KPI Totals
      kpiTotals.totalDiscountedLeads++
      kpiTotals.totalStandardFees += stdFee
      kpiTotals.totalAgreedAmount += agreed
      kpiTotals.totalDiscountGiven += discount
      if (st === 'QUALIFIED BUSINESS') {
        kpiTotals.qualifiedCount++
        kpiTotals.qualifiedDiscount += discount
      } else if (st === 'CONVERTED BUSINESS') {
        kpiTotals.convertedCount++
        kpiTotals.convertedDiscount += discount
      } else if (st === 'ONBOARDED BUSINESS') {
        kpiTotals.onboardedCount++
        kpiTotals.onboardedDiscount += discount
      }

      // Monthly bucket
      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, {
          month: monthKey,
          leadsCount: 0,
          qualifiedCount: 0,
          convertedCount: 0,
          onboardedCount: 0,
          totalStandardFees: 0,
          totalAgreedAmount: 0,
          totalDiscountGiven: 0,
        })
      }
      const mObj = monthlyMap.get(monthKey)
      mObj.leadsCount++
      if (st === 'QUALIFIED BUSINESS') mObj.qualifiedCount++
      else if (st === 'CONVERTED BUSINESS') mObj.convertedCount++
      else if (st === 'ONBOARDED BUSINESS') mObj.onboardedCount++
      mObj.totalStandardFees += stdFee
      mObj.totalAgreedAmount += agreed
      mObj.totalDiscountGiven += discount

      // By Sales Rep
      if (!repMap.has(repIdStr)) {
        repMap.set(repIdStr, {
          repId: repIdStr,
          repName,
          groupName: grp.groupName,
          managerName: grp.managerName,
          leadsCount: 0,
          qualifiedCount: 0,
          convertedCount: 0,
          onboardedCount: 0,
          totalStandardFees: 0,
          totalAgreedAmount: 0,
          totalDiscountGiven: 0,
        })
      }
      const rObj = repMap.get(repIdStr)
      rObj.leadsCount++
      if (st === 'QUALIFIED BUSINESS') rObj.qualifiedCount++
      else if (st === 'CONVERTED BUSINESS') rObj.convertedCount++
      else if (st === 'ONBOARDED BUSINESS') rObj.onboardedCount++
      rObj.totalStandardFees += stdFee
      rObj.totalAgreedAmount += agreed
      rObj.totalDiscountGiven += discount

      // By Group & Group Manager
      if (!groupMap.has(grp.groupId)) {
        groupMap.set(grp.groupId, {
          groupId: grp.groupId,
          groupName: grp.groupName,
          managerName: grp.managerName,
          leadsCount: 0,
          qualifiedCount: 0,
          convertedCount: 0,
          onboardedCount: 0,
          totalStandardFees: 0,
          totalAgreedAmount: 0,
          totalDiscountGiven: 0,
        })
      }
      const gObj = groupMap.get(grp.groupId)
      gObj.leadsCount++
      if (st === 'QUALIFIED BUSINESS') gObj.qualifiedCount++
      else if (st === 'CONVERTED BUSINESS') gObj.convertedCount++
      else if (st === 'ONBOARDED BUSINESS') gObj.onboardedCount++
      gObj.totalStandardFees += stdFee
      gObj.totalAgreedAmount += agreed
      gObj.totalDiscountGiven += discount

      // By Who Gave the Discount
      const authorKey = `${setById}_${setByName}`
      if (!authorMap.has(authorKey)) {
        authorMap.set(authorKey, {
          userId: setById,
          name: setByName,
          role: setByRole,
          leadsCount: 0,
          totalStandardFees: 0,
          totalAgreedAmount: 0,
          totalDiscountGiven: 0,
        })
      }
      const aObj = authorMap.get(authorKey)
      aObj.leadsCount++
      aObj.totalStandardFees += stdFee
      aObj.totalAgreedAmount += agreed
      aObj.totalDiscountGiven += discount

      leadRows.push({
        id: l._id.toString(),
        fullName: l.fullName,
        phone: l.phone || '',
        programName: prog,
        programVariant: l.businessProgramVariant || '',
        leadStatus: st,
        courseFees: stdFee,
        agreedAmount: agreed,
        discountAmount: discount,
        discountPercent: roundPct(discount, stdFee),
        paidAmount: paid,
        balanceAmount: Math.max(0, agreed - paid),
        assignedRepName: repName,
        groupName: grp.groupName,
        managerName: grp.managerName,
        discountSetBy: {
          userId: setById,
          name: setByName,
          role: setByRole,
          setAt: discountDate,
        },
        date: discountDate,
      })
    }

    kpiTotals.avgDiscountPercent = roundPct(kpiTotals.totalDiscountGiven, kpiTotals.totalStandardFees)

    const monthlyTrend = Array.from(monthlyMap.values())
      .map(m => ({ ...m, avgDiscountPercent: roundPct(m.totalDiscountGiven, m.totalStandardFees) }))
      .sort((a, b) => b.month.localeCompare(a.month))

    const bySalesRep = Array.from(repMap.values())
      .map(r => ({ ...r, avgDiscountPercent: roundPct(r.totalDiscountGiven, r.totalStandardFees) }))
      .sort((a, b) => b.totalDiscountGiven - a.totalDiscountGiven)

    const byGroup = Array.from(groupMap.values())
      .map(g => ({ ...g, avgDiscountPercent: roundPct(g.totalDiscountGiven, g.totalStandardFees) }))
      .sort((a, b) => b.totalDiscountGiven - a.totalDiscountGiven)

    const byDiscountAuthor = Array.from(authorMap.values())
      .map(a => ({ ...a, avgDiscountPercent: roundPct(a.totalDiscountGiven, a.totalStandardFees) }))
      .sort((a, b) => b.totalDiscountGiven - a.totalDiscountGiven)

    res.status(200).json({
      success: true,
      meta: {
        period,
        isAdmin: scope.isAdmin,
        isManager: scope.isManager,
      },
      kpiTotals,
      monthlyTrend,
      bySalesRep,
      byGroup,
      byDiscountAuthor,
      leads: leadRows,
      filterOptions: {
        counselors: visibleReps.map(r => ({ id: r._id.toString(), name: r.name })),
        teams: visibleGroups.map(g => ({ id: g._id.toString(), name: g.name })),
        programs: Array.from(programSet).sort(),
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * Classifies an assignment timestamp (IST, UTC+5:30) into SLA priority buckets:
 * 1. PAUSED: assigned during counselor's paused dates
 * 2. SUNDAY_HOLIDAY: Sunday in IST (explicitly relaxed holiday SLA)
 * 3. P1_9_TO_5: Mon-Sat 9:00 AM - 5:00 PM IST (Priority 1)
 * 4. P2_5_TO_8: Mon-Sat 5:00 PM - 8:00 PM IST (Priority 2)
 * 5. OTHER_HOURS: Mon-Sat 8:00 PM - 9:00 AM IST (Off-Hours)
 */
function classifyAssignmentWindowIST(assignedAt, repObj) {
  if (wasCounselorPausedAt(repObj, assignedAt)) {
    return { bucket: 'PAUSED', label: 'Paused Date (Excluded from SLA)', isHoliday: false }
  }
  // Convert to IST (UTC + 5h 30m)
  const istMs = new Date(assignedAt).getTime() + 5.5 * 60 * 60 * 1000
  const istDate = new Date(istMs)
  const dayOfWeek = istDate.getUTCDay() // 0 = Sunday
  const hour = istDate.getUTCHours()

  if (dayOfWeek === 0) {
    return { bucket: 'SUNDAY_HOLIDAY', label: 'Sunday • Holiday (Relaxed SLA)', isHoliday: true }
  }
  if (hour >= 9 && hour < 17) {
    return { bucket: 'P1_9_TO_5', label: 'Priority 1 (9 AM – 5 PM)', isHoliday: false }
  }
  if (hour >= 17 && hour < 20) {
    return { bucket: 'P2_5_TO_8', label: 'Priority 2 (5 PM – 8 PM)', isHoliday: false }
  }
  return { bucket: 'OTHER_HOURS', label: 'Other Hours (8 PM – 9 AM)', isHoliday: false }
}

// -------------------------------------------------------------
// GET /api/stats/response-sla
// Round-Robin Assignment -> First Contact SLA Report (Admin & Group Manager)
// Buckets: P1 (9-5), P2 (5-8), Sunday Holiday (Relaxed), Other Hours, Paused Dates
// -------------------------------------------------------------
export const getResponseSlaReport = async (req, res) => {
  try {
    const scope = await resolveManagerReportScope(req.user)
    const {
      period = 'current_month', // 'today' | 'week' | 'current_month' | 'till_date' | 'custom'
      fromDate = '',
      toDate = '',
      priorityBucket = 'All', // 'All' | 'P1_9_TO_5' | 'P2_5_TO_8' | 'SUNDAY_HOLIDAY' | 'OTHER_HOURS' | 'PAUSED'
      contactStatus = 'All', // 'All' | 'contacted' | 'pending'
      repId = 'All',
      groupId = 'All',
      page = 1,
      limit = 30,
    } = req.query

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))

    // Resolve date window
    let startDateObj = null
    let endDateObj = null
    const now = new Date()
    if (period === 'today') {
      startDateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      endDateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    } else if (period === 'week') {
      const diff = (now.getDay() + 6) % 7
      startDateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0, 0)
      endDateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    } else if (period === 'current_month') {
      startDateObj = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      endDateObj = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    } else if (period === 'custom' && (fromDate || toDate)) {
      if (fromDate) startDateObj = new Date(`${fromDate}T00:00:00.000`)
      if (toDate) endDateObj = new Date(`${toDate}T23:59:59.999`)
    }

    const [allRepsRaw, allGroupsRaw] = await Promise.all([
      User.find({ role: { $in: ['sales', 'manager'] }, receiveLeads: { $ne: false } })
        .sort({ name: 1 })
        .lean(),
      CounselorGroup.find().populate('managerId', 'name email').lean(),
    ])

    const visibleReps = scope.allowedRepIds
      ? allRepsRaw.filter(r => scope.allowedRepIds.includes(r._id.toString()))
      : allRepsRaw
    const visibleGroups = scope.allowedGroupIds
      ? allGroupsRaw.filter(g => scope.allowedGroupIds.includes(g._id.toString()))
      : allGroupsRaw

    const repObjMap = new Map(allRepsRaw.map(r => [r._id.toString(), r]))
    const repToGroupName = new Map()
    for (const g of allGroupsRaw) {
      if (g.managerId) repToGroupName.set(String(g.managerId._id || g.managerId), g.name)
      for (const m of g.memberIds || []) repToGroupName.set(String(m._id || m), g.name)
    }

    const andConditions = [{ assignmentStatus: 'ASSIGNED' }]
    if (scope.allowedRepIds && scope.allowedRepIds.length > 0) {
      andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants(scope.allowedRepIds) } })
    }
    if (groupId && groupId !== 'All') {
      const grp = visibleGroups.find(g => g._id.toString() === String(groupId))
      if (grp) {
        const gRepIds = new Set((grp.memberIds || []).map(m => String(m._id || m)))
        if (grp.managerId) gRepIds.add(String(grp.managerId._id || grp.managerId))
        andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants(Array.from(gRepIds)) } })
      }
    }
    if (repId && repId !== 'All') {
      andConditions.push({ 'assignedTo.repId': { $in: buildRepIdVariants([repId]) } })
    }

    const rawLeads = await Lead.find({ $and: andConditions })
      .select('fullName phone platform leadStatus status callAttempts assignedTo initialAdvisor steps createdAt updatedAt')
      .sort({ 'assignedTo.assignedAt': -1, createdAt: -1 })
      .lean()

    const makeBucketStats = () => ({
      total: 0,
      contacted: 0,
      pending: 0,
      totalResponseMins: 0,
      avgResponseMins: null,
      contactRate: 0,
    })

    const bucketTotals = {
      overall: makeBucketStats(),
      P1_9_TO_5: makeBucketStats(),
      P2_5_TO_8: makeBucketStats(),
      SUNDAY_HOLIDAY: makeBucketStats(),
      OTHER_HOURS: makeBucketStats(),
      PAUSED: makeBucketStats(),
    }

    const repStatsMap = new Map()
    for (const r of visibleReps) {
      const rid = r._id.toString()
      repStatsMap.set(rid, {
        repId: rid,
        repName: r.name,
        groupName: repToGroupName.get(rid) || 'Ungrouped',
        overall: makeBucketStats(),
        P1_9_TO_5: makeBucketStats(),
        P2_5_TO_8: makeBucketStats(),
        SUNDAY_HOLIDAY: makeBucketStats(),
        OTHER_HOURS: makeBucketStats(),
        PAUSED: makeBucketStats(),
      })
    }

    const matchedLeadRows = []
    const nowMs = Date.now()

    for (const l of rawLeads) {
      const assignedAtRaw = l.assignedTo?.assignedAt || l.initialAdvisor?.assignedAt || l.createdAt
      const assignedAt = assignedAtRaw ? new Date(assignedAtRaw) : null
      if (!assignedAt || Number.isNaN(assignedAt.getTime())) continue
      if (startDateObj && assignedAt < startDateObj) continue
      if (endDateObj && assignedAt > endDateObj) continue

      const repIdStr = l.assignedTo?.repId ? String(l.assignedTo.repId) : ''
      const repName = l.assignedTo?.repName || 'Unassigned'
      const repObj = repObjMap.get(repIdStr) || null

      // Determine first real counselor interaction timestamp
      const validSteps = (Array.isArray(l.steps) ? l.steps : [])
        .filter(
          s =>
            s &&
            s.selectedCategory !== 'admin_recycled' &&
            s.selectedCategory !== 'auto_recycled' &&
            s.updatedBy?.role !== 'system' &&
            s.timestamp
        )
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

      let firstContactAt = null
      if (validSteps.length > 0) {
        firstContactAt = new Date(validSteps[0].timestamp)
      } else if (l.status === 'Contacted' || (l.callAttempts || 0) > 0) {
        firstContactAt = l.updatedAt ? new Date(l.updatedAt) : null
      }

      const isContacted = Boolean(firstContactAt)
      const responseMinutes = isContacted
        ? Math.max(0, Math.round((firstContactAt.getTime() - assignedAt.getTime()) / 60000))
        : null
      const pendingMinutes = !isContacted
        ? Math.max(0, Math.round((nowMs - assignedAt.getTime()) / 60000))
        : null

      const cls = classifyAssignmentWindowIST(assignedAt, repObj)

      // Update KPI & Rep aggregates BEFORE lead-level bucket/contact filtering
      const addToStats = stObj => {
        stObj.total++
        if (isContacted) {
          stObj.contacted++
          stObj.totalResponseMins += responseMinutes
        } else {
          stObj.pending++
        }
      }

      addToStats(bucketTotals.overall)
      addToStats(bucketTotals[cls.bucket])

      if (repIdStr && repStatsMap.has(repIdStr)) {
        const rStat = repStatsMap.get(repIdStr)
        addToStats(rStat.overall)
        addToStats(rStat[cls.bucket])
      }

      // Apply lead-level table filters
      if (priorityBucket !== 'All' && cls.bucket !== priorityBucket) continue
      if (contactStatus === 'contacted' && !isContacted) continue
      if (contactStatus === 'pending' && isContacted) continue

      matchedLeadRows.push({
        id: l._id.toString(),
        fullName: l.fullName,
        phone: l.phone || '',
        platform: l.platform || '',
        leadStatus: l.leadStatus || 'NEW LEAD',
        assignedRepName: repName,
        groupName: repToGroupName.get(repIdStr) || 'Ungrouped',
        assignedAt,
        firstContactAt,
        isContacted,
        responseMinutes,
        pendingMinutes,
        priorityBucket: cls.bucket,
        priorityLabel: cls.label,
        isHoliday: cls.isHoliday,
      })
    }

    const finalizeBucket = st => {
      st.avgResponseMins = st.contacted > 0 ? Math.round(st.totalResponseMins / st.contacted) : null
      st.contactRate = st.total > 0 ? Math.round((st.contacted / st.total) * 100) : 0
      return st
    }

    Object.values(bucketTotals).forEach(finalizeBucket)

    const bySalesRep = Array.from(repStatsMap.values()).map(r => {
      finalizeBucket(r.overall)
      finalizeBucket(r.P1_9_TO_5)
      finalizeBucket(r.P2_5_TO_8)
      finalizeBucket(r.SUNDAY_HOLIDAY)
      finalizeBucket(r.OTHER_HOURS)
      finalizeBucket(r.PAUSED)
      return r
    })

    const totalFiltered = matchedLeadRows.length
    const pagedLeads = matchedLeadRows.slice((pageNum - 1) * limitNum, pageNum * limitNum)

    res.status(200).json({
      success: true,
      meta: {
        period,
        timezone: 'IST (UTC+5:30)',
        isAdmin: scope.isAdmin,
        isManager: scope.isManager,
      },
      kpiTotals: bucketTotals,
      bySalesRep,
      leads: pagedLeads,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalFiltered,
        totalPages: Math.max(1, Math.ceil(totalFiltered / limitNum)),
      },
      filterOptions: {
        counselors: visibleReps.map(r => ({ id: r._id.toString(), name: r.name })),
        teams: visibleGroups.map(g => ({ id: g._id.toString(), name: g.name })),
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
