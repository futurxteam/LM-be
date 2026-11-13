import Lead from '../models/Lead.js'
import User from '../models/User.js'

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

    // 7. Preferred Location Breakdown
    const locationAgg = await Lead.aggregate([
      {
        $group: {
          _id: {
            $cond: [
              {
                $regexMatch: {
                  input: '$preferredLocation',
                  regex: /uae|dubai|abu dhabi|gcc|saudi/i,
                },
              },
              'UAE / GCC',
              {
                $cond: [
                  {
                    $regexMatch: {
                      input: '$preferredLocation',
                      regex: /kochi|ernakulam|ekm/i,
                    },
                  },
                  'Kochi / Ernakulam',
                  {
                    $cond: [
                      {
                        $regexMatch: {
                          input: '$preferredLocation',
                          regex: /palakkad/i,
                        },
                      },
                      'Palakkad',
                      {
                        $cond: [
                          {
                            $regexMatch: {
                              input: '$preferredLocation',
                              regex: /thrissur|trichur/i,
                            },
                          },
                          'Thrissur',
                          '$preferredLocation',
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 8 },
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
