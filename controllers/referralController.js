import mongoose from 'mongoose'
import Referral from '../models/Referral.js'
import Lead from '../models/Lead.js'
import { fetchBulkClassTeachersFromLms, normalizePhoneLast10 } from './studentController.js'

function getDateRangeFilter(dateFilter, startDate, endDate) {
  const now = new Date()
  let from = null
  let to = null

  if (startDate || endDate) {
    if (startDate) from = new Date(startDate)
    if (endDate) {
      to = new Date(endDate)
      to.setHours(23, 59, 59, 999)
    }
  } else if (dateFilter === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  } else if (dateFilter === 'week' || dateFilter === 'this_week') {
    const dayOfWeek = now.getDay()
    const diffToMonday = (dayOfWeek + 6) % 7
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday)
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  } else if (dateFilter === 'month' || dateFilter === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1)
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  } else if (dateFilter === 'last_month') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
  } else if (dateFilter === 'year' || dateFilter === 'this_year') {
    from = new Date(now.getFullYear(), 0, 1)
    to = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999)
  }

  const range = {}
  if (from && !isNaN(from.getTime())) range.$gte = from
  if (to && !isNaN(to.getTime())) range.$lte = to
  return Object.keys(range).length > 0 ? range : null
}

// -------------------------------------------------------------
// GET /api/referrals - List referrals with search & filters
// -------------------------------------------------------------
export const getReferrals = async (req, res) => {
  try {
    const {
      referralType,
      status,
      search,
      dateFilter,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = req.query

    const filter = {}

    if (referralType && referralType !== 'all') {
      filter.referralType = referralType
    }

    if (status && status !== 'all') {
      if (status === 'converted') {
        filter.isConverted = true
      } else if (status === 'onboarded') {
        filter.isOnboarded = true
      } else if (status === 'qualified') {
        filter.isQualified = true
      } else {
        filter.leadStatus = status
      }
    }

    const dateRange = getDateRangeFilter(dateFilter, startDate, endDate)
    if (dateRange) {
      filter.createdAt = dateRange
    }

    if (search && search.trim()) {
      const q = search.trim()
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { referrerName: regex },
        { referrerPhone: regex },
        { referrerCourse: regex },
        { referrerBatch: regex },
        { referredCandidateName: regex },
        { referredCandidatePhone: regex },
        { referredCandidateCourse: regex },
      ]
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const skip = (pageNum - 1) * limitNum

    const [total, referrals] = await Promise.all([
      Referral.countDocuments(filter),
      Referral.find(filter)
        .populate('referredLeadId', 'fullName phone email leadStatus status subStatus paidAmount courseFees assignedTo')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ])

    // Format referral rows
    const formatted = referrals.map(r => {
      const liveLead = r.referredLeadId || {}
      return {
        id: r._id.toString(),
        referralType: r.referralType,
        referrerName: r.referrerName,
        referrerPhone: r.referrerPhone,
        referrerEmail: r.referrerEmail,
        referrerCourse: r.referrerCourse,
        referrerBatch: r.referrerBatch,
        referrerClassTeacher: r.referrerClassTeacher || '',
        referrerLmsUserId: r.referrerLmsUserId || '',
        isAlumni: Boolean(r.isAlumni),

        referredLeadId: liveLead._id ? liveLead._id.toString() : (r.referredLeadId ? r.referredLeadId.toString() : null),
        candidateName: liveLead.fullName || r.referredCandidateName,
        candidatePhone: liveLead.phone || r.referredCandidatePhone,
        candidateCourse: liveLead.courseProgram || r.referredCandidateCourse,

        leadStatus: liveLead.leadStatus || r.leadStatus,
        isQualified: Boolean(r.isQualified || liveLead.leadStatus === 'QUALIFIED BUSINESS'),
        isConverted: Boolean(r.isConverted || liveLead.leadStatus === 'CONVERTED BUSINESS' || liveLead.leadStatus === 'ONBOARDED BUSINESS'),
        isOnboarded: Boolean(r.isOnboarded || liveLead.leadStatus === 'ONBOARDED BUSINESS'),
        paidAmount: liveLead.paidAmount ?? r.paidAmount ?? 0,
        courseFees: liveLead.courseFees ?? r.courseFees ?? 0,
        agreedAmount: liveLead.agreedAmount ?? r.agreedAmount ?? 0,
        discountAmount: liveLead.discountAmount ?? r.discountAmount ?? 0,
        assignedTo: liveLead.assignedTo || r.assignedCounselor || null,

        convertedAt: r.convertedAt,
        onboardedAt: r.onboardedAt,
        createdAt: r.createdAt,
      }
    })

    res.status(200).json({
      success: true,
      referrals: formatted,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/referrals/stats - Demographic reports & analytics
// -------------------------------------------------------------
export const getReferralStats = async (req, res) => {
  try {
    const { dateFilter = 'this_year', startDate, endDate, referralType } = req.query

    const matchQuery = {}
    if (referralType && referralType !== 'all') {
      matchQuery.referralType = referralType
    }
    const dateRange = getDateRangeFilter(dateFilter, startDate, endDate)
    if (dateRange) {
      matchQuery.createdAt = dateRange
    }

    const allMatching = await Referral.find(matchQuery).lean()

    // Bulk resolve Class Teachers from fa-backend for ongoing student referrers
    const ongoingStudentQueries = []
    const seenStudentQueryKeys = new Set()
    for (const ref of allMatching) {
      if (ref.referralType === 'student' && !ref.isAlumni) {
        const key = `${ref.referrerLmsUserId || ''}_${normalizePhoneLast10(ref.referrerPhone)}_${(ref.referrerEmail || '').toLowerCase()}`
        if (!seenStudentQueryKeys.has(key) && (ref.referrerLmsUserId || ref.referrerPhone || ref.referrerEmail)) {
          seenStudentQueryKeys.add(key)
          ongoingStudentQueries.push({
            lmsUserId: ref.referrerLmsUserId || '',
            phone: ref.referrerPhone || '',
            email: ref.referrerEmail || '',
          })
        }
      }
    }
    const lmsClassTeacherLookup = ongoingStudentQueries.length
      ? await fetchBulkClassTeachersFromLms(ongoingStudentQueries)
      : { byId: {}, byPhone: {}, byEmail: {} }

    const resolveTeacherInfo = ref => {
      if (ref.referralType !== 'student' || ref.isAlumni) return { classTeacherName: '', classTeachers: [], batchName: ref.referrerBatch || '', lmsUserId: ref.referrerLmsUserId || '' }
      const byId = ref.referrerLmsUserId ? lmsClassTeacherLookup.byId[ref.referrerLmsUserId] : null
      const p10 = normalizePhoneLast10(ref.referrerPhone)
      const byPhone = p10 ? lmsClassTeacherLookup.byPhone[p10] : null
      const byEmail = ref.referrerEmail ? lmsClassTeacherLookup.byEmail[ref.referrerEmail.toLowerCase()] : null
      const matched = byId || byPhone || byEmail
      if (matched) {
        return {
          classTeacherName: matched.classTeacherName || ref.referrerClassTeacher || '',
          classTeachers: Array.isArray(matched.classTeachers) ? matched.classTeachers : [],
          batchName: matched.batchName && matched.batchName !== 'Not Assigned' ? matched.batchName : (ref.referrerBatch || ''),
          lmsUserId: matched.lmsUserId || ref.referrerLmsUserId || '',
        }
      }
      return {
        classTeacherName: ref.referrerClassTeacher || '',
        classTeachers: ref.referrerClassTeacher ? [{ name: ref.referrerClassTeacher, email: '', phone: '' }] : [],
        batchName: ref.referrerBatch || '',
        lmsUserId: ref.referrerLmsUserId || '',
      }
    }

    const totalCount = allMatching.length
    let convertedCount = 0
    let onboardedCount = 0
    let qualifiedCount = 0
    let totalRevenue = 0

    // Type Breakdown
    const byType = {
      lead: { count: 0, converted: 0, revenue: 0 },
      student: { count: 0, converted: 0, revenue: 0 },
      alumni: { count: 0, converted: 0, revenue: 0 },
    }

    // Demographics: Course & Batch distribution
    const byCourse = {}
    const byBatch = {}

    // Leaderboard of Top Referrers
    const referrersMap = new Map()

    // Leaderboard of Class Teachers (from ongoing student referrals)
    const classTeacherMap = new Map()

    // Monthly Trend (Year-Month buckets)
    const monthlyTrendMap = new Map()

    for (const ref of allMatching) {
      const type = ref.referralType || 'student'
      const isConv = Boolean(ref.isConverted || ref.leadStatus === 'CONVERTED BUSINESS' || ref.leadStatus === 'ONBOARDED BUSINESS')
      const isOnb = Boolean(ref.isOnboarded || ref.leadStatus === 'ONBOARDED BUSINESS')
      const isQual = Boolean(ref.isQualified || ref.leadStatus === 'QUALIFIED BUSINESS')
      const rev = Number(ref.paidAmount) || 0
      const teacherInfo = resolveTeacherInfo(ref)

      if (isConv) convertedCount++
      if (isOnb) onboardedCount++
      if (isQual) qualifiedCount++
      totalRevenue += rev

      if (byType[type]) {
        byType[type].count++
        if (isConv) byType[type].converted++
        byType[type].revenue += rev
      }

      // Course demographics
      const c = ref.referrerCourse || ref.referredCandidateCourse || 'General'
      byCourse[c] = (byCourse[c] || 0) + 1

      // Batch demographics
      const b = teacherInfo.batchName || ref.referrerBatch || 'Unspecified Batch'
      byBatch[b] = (byBatch[b] || 0) + 1

      // Leaderboard
      const refKey = `${ref.referrerName}_${ref.referrerPhone || ''}`
      if (!referrersMap.has(refKey)) {
        referrersMap.set(refKey, {
          name: ref.referrerName,
          phone: ref.referrerPhone || '',
          email: ref.referrerEmail || '',
          lmsUserId: teacherInfo.lmsUserId || '',
          type: ref.referralType,
          course: ref.referrerCourse || '',
          batch: teacherInfo.batchName || ref.referrerBatch || '',
          classTeacher: teacherInfo.classTeacherName || '',
          classTeachers: teacherInfo.classTeachers || [],
          isAlumni: Boolean(ref.isAlumni),
          totalReferrals: 0,
          convertedCount: 0,
          onboardedCount: 0,
          totalRevenue: 0,
        })
      }
      const rObj = referrersMap.get(refKey)
      rObj.totalReferrals++
      if (isConv) rObj.convertedCount++
      if (isOnb) rObj.onboardedCount++
      rObj.totalRevenue += rev
      if (!rObj.classTeacher && teacherInfo.classTeacherName) {
        rObj.classTeacher = teacherInfo.classTeacherName
        rObj.classTeachers = teacherInfo.classTeachers
      }

      // Class Teacher Leaderboard (for ongoing student referrals)
      if (ref.referralType === 'student' && !ref.isAlumni) {
        const teachersList = teacherInfo.classTeachers.length
          ? teacherInfo.classTeachers
          : [{ id: '', name: teacherInfo.classTeacherName || 'Unassigned Class Teacher', email: '', phone: '' }]

        for (const t of teachersList) {
          const tName = t.name || 'Unassigned Class Teacher'
          const tKey = t.id || tName.toLowerCase()
          if (!classTeacherMap.has(tKey)) {
            classTeacherMap.set(tKey, {
              teacherId: t.id || '',
              teacherName: tName,
              teacherEmail: t.email || '',
              teacherPhone: t.phone || '',
              totalReferrals: 0,
              convertedCount: 0,
              onboardedCount: 0,
              totalRevenue: 0,
              studentSet: new Set(),
            })
          }
          const ctObj = classTeacherMap.get(tKey)
          ctObj.totalReferrals++
          if (isConv) ctObj.convertedCount++
          if (isOnb) ctObj.onboardedCount++
          ctObj.totalRevenue += rev
          ctObj.studentSet.add(refKey)
        }
      }

      // Monthly Trend
      const d = new Date(ref.createdAt)
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!monthlyTrendMap.has(monthKey)) {
        monthlyTrendMap.set(monthKey, { month: monthKey, total: 0, converted: 0, revenue: 0 })
      }
      const mObj = monthlyTrendMap.get(monthKey)
      mObj.total++
      if (isConv) mObj.converted++
      mObj.revenue += rev
    }

    const conversionRate = totalCount > 0 ? Math.round((convertedCount / totalCount) * 100) : 0

    // Sort leaderboard by convertedCount DESC, then totalReferrals DESC
    const leaderboard = Array.from(referrersMap.values())
      .sort((a, b) => b.convertedCount !== a.convertedCount ? b.convertedCount - a.convertedCount : b.totalReferrals - a.totalReferrals)
      .slice(0, 15)

    // Ongoing students who referred (for clickable list in Referral Panel)
    const ongoingStudentReferrers = Array.from(referrersMap.values())
      .filter(r => r.type === 'student' && !r.isAlumni)
      .sort((a, b) => b.totalReferrals - a.totalReferrals)

    // Sort Class Teacher Leaderboard by convertedCount DESC, then totalReferrals DESC
    const classTeacherLeaderboard = Array.from(classTeacherMap.values())
      .map(ct => ({
        teacherId: ct.teacherId,
        teacherName: ct.teacherName,
        teacherEmail: ct.teacherEmail,
        teacherPhone: ct.teacherPhone,
        referringStudentsCount: ct.studentSet.size,
        totalReferrals: ct.totalReferrals,
        convertedCount: ct.convertedCount,
        onboardedCount: ct.onboardedCount,
        conversionRate: ct.totalReferrals > 0 ? Math.round((ct.convertedCount / ct.totalReferrals) * 100) : 0,
        totalRevenue: ct.totalRevenue,
      }))
      .sort((a, b) =>
        b.convertedCount !== a.convertedCount
          ? b.convertedCount - a.convertedCount
          : b.totalReferrals - a.totalReferrals
      )

    // Sort monthly trend chronologically
    const monthlyTrend = Array.from(monthlyTrendMap.values()).sort((a, b) => a.month.localeCompare(b.month))

    // Top courses
    const courseBreakdown = Object.entries(byCourse)
      .map(([course, count]) => ({ course, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    // Top batches
    const batchBreakdown = Object.entries(byBatch)
      .map(([batch, count]) => ({ batch, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    res.status(200).json({
      success: true,
      stats: {
        totalCount,
        totalReferrals: totalCount,
        convertedCount,
        onboardedCount,
        qualifiedCount,
        conversionRate,
        totalRevenue,
        kpis: {
          totalReferrals: totalCount,
          qualified: qualifiedCount,
          converted: convertedCount,
          onboarded: onboardedCount,
          conversionRate,
          totalRevenue,
        },
        demographics: {
          byType: {
            lead: byType.lead.count,
            student: byType.student.count,
            alumni: byType.alumni.count,
          },
          byCourse: courseBreakdown,
          byBatch: batchBreakdown,
        },
        byType: {
          lead: byType.lead.count,
          student: byType.student.count,
          alumni: byType.alumni.count,
          details: {
            lead: { ...byType.lead, conversionRate: byType.lead.count > 0 ? Math.round((byType.lead.converted / byType.lead.count) * 100) : 0 },
            student: { ...byType.student, conversionRate: byType.student.count > 0 ? Math.round((byType.student.converted / byType.student.count) * 100) : 0 },
            alumni: { ...byType.alumni, conversionRate: byType.alumni.count > 0 ? Math.round((byType.alumni.converted / byType.alumni.count) * 100) : 0 },
          },
        },
        courseBreakdown,
        batchBreakdown,
        leaderboard,
        ongoingStudentReferrers,
        classTeacherLeaderboard,
        monthlyTrend,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

