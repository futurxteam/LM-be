import Student from '../models/Student.js'

function sanitizePhone(phone) {
  if (!phone) return ''
  return String(phone).replace(/[^\d+]/g, '')
}

// LMS API Configuration (Strictly via HTTP API with permanent access key)
const FA_API_KEY = process.env.FA_LMS_API_KEY
const FA_API_URL = process.env.FA_LMS_API_URL
// -------------------------------------------------------------
// GET /api/students/lms-search
// 1. Searches local CRM Student DB first
// 2. If not found in local DB, queries fa-backend LMS HTTP API
// 3. Strictly READ-ONLY during search (Zero DB writes on search!)
// -------------------------------------------------------------
export const searchLmsStudents = async (req, res) => {
  try {
    const { query = '', type = 'all', limit = 20 } = req.query
    const maxResults = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)
    const cleanQuery = String(query || '').trim()
    const cleanP = sanitizePhone(cleanQuery)

    // 1. Search local CRM Student DB first
    const localFilter = {}
    if (type === 'alumni') {
      localFilter.$or = [{ isAlumni: true }, { status: 'alumni' }, { status: 'completed' }]
    } else if (type === 'student') {
      localFilter.isAlumni = { $ne: true }
    }

    if (cleanQuery) {
      const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(escaped, 'i')
      const searchFields = [
        { name: regex },
        { email: regex },
        { course: regex },
        { batch: regex },
        { studentId: regex },
      ]
      if (cleanP && cleanP.length >= 3) {
        searchFields.push({ phone: new RegExp(cleanP, 'i') })
      }

      if (localFilter.$or) {
        localFilter.$and = [{ $or: localFilter.$or }, { $or: searchFields }]
        delete localFilter.$or
      } else {
        localFilter.$or = searchFields
      }
    }

    const localStudents = await Student.find(localFilter).limit(maxResults).lean()

    const formattedLocal = localStudents.map(s => ({
      id: s._id.toString(),
      lmsUserId: s.lmsUserId || '',
      name: s.name,
      phone: s.phone,
      email: s.email || '',
      course: s.course || '',
      batch: s.batch || '',
      rollNo: s.studentId || '',
      isAlumni: Boolean(s.isAlumni),
      status: s.status,
      isVerifiedLms: Boolean(s.isVerifiedLms),
      source: 'local',
    }))

    // If local results satisfy the limit, return them immediately
    if (formattedLocal.length >= maxResults) {
      return res.status(200).json({
        success: true,
        count: formattedLocal.length,
        data: formattedLocal,
      })
    }

    // 2. If not found or fewer than limit, search LMS via fa-backend REST API
    let lmsFormatted = []
    try {
      const remainingLimit = maxResults - formattedLocal.length
      const url = `${FA_API_URL}?query=${encodeURIComponent(cleanQuery)}&type=${encodeURIComponent(type)}&limit=${remainingLimit}`

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': FA_API_KEY,
          'Content-Type': 'application/json',
        },
      })

      if (response.ok) {
        const json = await response.json()
        const lmsData = Array.isArray(json.data) ? json.data : []

        // Avoid duplicates already in formattedLocal
        const existingPhones = new Set(formattedLocal.map(s => sanitizePhone(s.phone)).filter(Boolean))
        const existingLmsIds = new Set(formattedLocal.map(s => s.lmsUserId).filter(Boolean))

        lmsFormatted = lmsData
          .filter(item => {
            const p = sanitizePhone(item.phone)
            if (p && existingPhones.has(p)) return false
            if (item.lmsUserId && existingLmsIds.has(item.lmsUserId)) return false
            return true
          })
          .map(item => ({
            id: null, // Indicates not yet registered locally in CRM Student DB
            lmsUserId: item.lmsUserId || '',
            name: item.name,
            phone: item.phone,
            email: item.email || '',
            course: item.courseName || '',
            batch: item.batchName || '',
            rollNo: item.rollNo || '',
            isAlumni: Boolean(item.isAlumni),
            status: item.status,
            isVerifiedLms: true,
            source: 'lms',
          }))
      } else {
        console.warn(`[searchLmsStudents] LMS API returned ${response.status}`)
      }
    } catch (lmsErr) {
      console.warn('⚠️ Could not query LMS API:', lmsErr.message)
    }

    // Combine local results + LMS results (strictly READ-ONLY, 0 database writes)
    const combined = [...formattedLocal, ...lmsFormatted].slice(0, maxResults)

    res.status(200).json({
      success: true,
      count: combined.length,
      data: combined,
    })
  } catch (error) {
    console.error('[searchLmsStudents] Error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to search students',
      error: error.message,
    })
  }
}

// -------------------------------------------------------------
// GET /api/students - Search and list local CRM students
// -------------------------------------------------------------
export const getStudents = async (req, res) => {
  try {
    const { search = '', isAlumni, course, batch, page = 1, limit = 20 } = req.query

    const filter = {}
    if (isAlumni !== undefined && isAlumni !== '') {
      filter.isAlumni = isAlumni === 'true' || isAlumni === true
    }
    if (course) {
      filter.course = new RegExp(String(course).trim(), 'i')
    }
    if (batch) {
      filter.batch = new RegExp(String(batch).trim(), 'i')
    }
    if (search && search.trim()) {
      const q = search.trim()
      const cleanP = sanitizePhone(q)
      const orClauses = [
        { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { course: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { batch: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      ]
      if (cleanP && cleanP.length >= 3) {
        orClauses.push({ phone: new RegExp(cleanP, 'i') })
      }
      filter.$or = orClauses
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const skip = (pageNum - 1) * limitNum

    const [total, students] = await Promise.all([
      Student.countDocuments(filter),
      Student.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
    ])

    res.status(200).json({
      success: true,
      students: students.map(s => ({
        id: s._id.toString(),
        name: s.name,
        phone: s.phone,
        email: s.email,
        course: s.course,
        batch: s.batch,
        isAlumni: s.isAlumni,
        status: s.status,
        isVerifiedLms: s.isVerifiedLms,
        createdAt: s.createdAt,
      })),
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
// POST /api/students - Quick create student / alumni
// -------------------------------------------------------------
export const createStudent = async (req, res) => {
  try {
    const { name, phone, email = '', course = '', batch = '', isAlumni = false, status, notes = '' } = req.body

    const trimmedName = String(name || '').trim()
    const cleanP = sanitizePhone(phone)

    if (!trimmedName) {
      return res.status(400).json({ success: false, message: 'Student full name is required' })
    }
    if (!cleanP || cleanP.length < 6) {
      return res.status(400).json({ success: false, message: 'Valid phone number is required' })
    }

    let student = await Student.findOne({ phone: cleanP })
    if (student) {
      if (course && !student.course) student.course = course
      if (batch && !student.batch) student.batch = batch
      if (isAlumni && !student.isAlumni) student.isAlumni = true
      await student.save()

      return res.status(200).json({
        success: true,
        message: `Existing student found: ${student.name}`,
        student: {
          id: student._id.toString(),
          name: student.name,
          phone: student.phone,
          course: student.course,
          batch: student.batch,
          isAlumni: student.isAlumni,
        },
      })
    }

    student = new Student({
      name: trimmedName,
      phone: cleanP,
      email: String(email || '').trim().toLowerCase(),
      course: String(course || '').trim(),
      batch: String(batch || '').trim(),
      isAlumni: Boolean(isAlumni),
      status: status || (isAlumni ? 'alumni' : 'active'),
      notes: String(notes || '').trim(),
    })

    await student.save()

    res.status(201).json({
      success: true,
      message: `${isAlumni ? 'Alumni' : 'Student'} profile created successfully`,
      student: {
        id: student._id.toString(),
        name: student.name,
        phone: student.phone,
        email: student.email,
        course: student.course,
        batch: student.batch,
        isAlumni: student.isAlumni,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
