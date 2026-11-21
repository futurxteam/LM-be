import mongoose from 'mongoose'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import CounselorGroup from '../models/CounselorGroup.js'
import {
  getOrCreateCrmSettings,
  LEAD_STATUSES,
  BUSINESS_STATUSES,
  deriveHeatTierFromStatus,
} from '../models/CrmSettings.js'

export const getStats = async (req, res) => {
  try {
    const totalLeads = await Lead.countDocuments()
    const poolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })
    const assignedCount = await Lead.countDocuments({ assignmentStatus: 'ASSIGNED' })
    const contactedCount = await Lead.countDocuments({ status: 'Contacted' })
    const notContactedCount = await Lead.countDocuments({ status: 'Not Contacted' })
    const enrolledCount = await Lead.countDocuments({ subStatus: { $regex: /enrolled/i } })

    const contactRate = assignedCount > 0 ? Math.round((contactedCount / assignedCount) * 100) : 0
    const conversionRate = totalLeads > 0 ? Math.round((enrolledCount / totalLeads) * 100) : 0

    // 1. Success Status Report (Success vs Pending vs In Pool)
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
        count: notContactedCount - poolCount,
        percentage: totalLeads > 0 ? Math.round(((notContactedCount - poolCount) / totalLeads) * 100) : 0,
        color: '#f59e0b',
        type: 'pending',
      },
      {
        status: 'Unassigned in Lead Pool',
        count: poolCount,
        percentage: totalLeads > 0 ? Math.round((poolCount / totalLeads) * 100) : 0,
        color: '#8b5cf6',
        type: 'pool',
      },
    ]

    // 2. Current Stage Report (Granular Sub-Stages)
    const stageAgg = await Lead.aggregate([
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
    const salesReps = await User.find({ role: 'sales' }).lean()
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

    // 4. Campaign Attribution Aggregation
    const campaignAgg = await Lead.aggregate([
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

    // 5. Platform Split (Instagram vs Facebook)
    const platformAgg = await Lead.aggregate([
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    const platformReport = platformAgg.map(p => ({
      name: p._id || 'Meta Ads',
      count: p.count,
      percentage: totalLeads > 0 ? Math.round((p.count / totalLeads) * 100) : 0,
    }))

    // 6. Qualification Breakdown
    const qualAgg = await Lead.aggregate([
      { $group: { _id: '$qualification', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    const qualificationReport = qualAgg.map(q => ({
      name: q._id || 'Other',
      count: q.count,
      percentage: totalLeads > 0 ? Math.round((q.count / totalLeads) * 100) : 0,
    }))

    // 7. Preferred Location / Saved District & State Demography Breakdown
    const locationAgg = await Lead.aggregate([
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
// Hot / Warm / Cold Visual & Table Reports, 10-Status Lifecycle Funnel,
// Recyclable Lost Cycles, Business Value vs Paid Collection & Counselor Matrix
// -------------------------------------------------------------
export const getAdvancedReports = async (req, res) => {
  try {
    const {
      heatTier,
      leadStatus,
      repId,
      groupId,
      programName,
      fromDate,
      toDate,
      search,
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

    const andConditions = []
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
          fullName: lead.fullName,
          phone: lead.phone,
          email: lead.email,
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

    // 5. Filterable Hot / Warm / Cold Table Rows
    let tableLeads = normalizedLeads
    if (heatTier && heatTier !== 'All') {
      tableLeads = tableLeads.filter(l => (l.heatTier || 'UNCLASSIFIED') === heatTier)
    }
    if (leadStatus && leadStatus !== 'All') {
      tableLeads = tableLeads.filter(l => l.leadStatus === leadStatus)
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase()
      tableLeads = tableLeads.filter(
        l =>
          (l.fullName || '').toLowerCase().includes(q) ||
          (l.phone || '').toLowerCase().includes(q) ||
          (l.selectedCategoryLabel || '').toLowerCase().includes(q) ||
          (l.assignedTo?.repName || '').toLowerCase().includes(q) ||
          (l.businessProgramName || '').toLowerCase().includes(q)
      )
    }

    const heatTableTotal = tableLeads.length
    const heatTableTotalPages = Math.max(1, Math.ceil(heatTableTotal / heatPageSize))
    const heatPagedLeads = tableLeads.slice(
      (heatPageNum - 1) * heatPageSize,
      heatPageNum * heatPageSize
    )

    const heatTableRows = heatPagedLeads.map(l => ({
      id: l.id,
      fullName: l.fullName,
      phone: l.phone,
      email: l.email,
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

    // Backend pagination for Recyclable Lost Leads & Max-Limit Lost Leads tables
    const recycleTotal = recyclableLostLeads.length
    const recycleTotalPages = Math.max(1, Math.ceil(recycleTotal / recPageSize))
    const pagedRecyclableLeads = recyclableLostLeads.slice(
      (recPageNum - 1) * recPageSize,
      recPageNum * recPageSize
    )

    const maxLostTotal = maxLostLeads.length
    const maxLostTotalPages = Math.max(1, Math.ceil(maxLostTotal / maxLostPageSize))
    const pagedMaxLostLeads = maxLostLeads.slice(
      (maxLostPageNum - 1) * maxLostPageSize,
      maxLostPageNum * maxLostPageSize
    )

    // 6. Counselor Performance Matrix
    const [salesReps, counselorGroups] = await Promise.all([
      User.find({ role: 'sales' }).lean(),
      CounselorGroup.find().populate('managerId', 'name email title').lean(),
    ])
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

    const poolOnlyLeads = normalizedLeads.filter(l => l.assignmentStatus === 'UNASSIGNED')
    if (poolOnlyLeads.length > 0) {
      groupReport.push(
        buildGroupStats('system_pool', 'Unassigned (System Pool)', '—', 0, poolOnlyLeads, true)
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
