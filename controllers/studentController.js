import Student from '../models/Student.js'

function sanitizePhone(phone) {
  if (!phone) return ''
  return String(phone).replace(/[^\d+]/g, '')
}

// LMS API Configuration (Strictly via HTTP API with permanent access key)
const FA_API_KEY = process.env.FA_LMS_API_KEY || 'fa_sec_live_9b4e7a2f1c8d5e0a3b6c9d2e4f7a1b8c'
const FA_API_URL = process.env.FA_LMS_API_URL || 'https://fa-backend-wont.onrender.com/api/external/students/search'

// -------------------------------------------------------------
// GET /api/students/lms-search - Live Search Verified LMS Students & Alumni
// Strictly queries fa-backend REST API
// -------------------------------------------------------------
export const searchLmsStudents = async (req, res) => {
  try {
    const { query = '', type = 'all', limit = 20 } = req.query

    const url = `${FA_API_URL}?query=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=${limit}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': FA_API_KEY,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('[searchLmsStudents] fa-backend API error:', response.status, errText)
      return res.status(response.status).json({
        success: false,
        message: `LMS API responded with status ${response.status}`,
        error: errText,
      })
    }

    const json = await response.json()
    const lmsData = Array.isArray(json.data) ? json.data : []

    // Ensure matched LMS students exist in local CRM Student collection for clean local relations
    const verifiedStudents = await Promise.all(
      lmsData.map(async item => {
        const cleanP = sanitizePhone(item.phone)
        let localStudent = null
        if (item.lmsUserId) {
          localStudent = await Student.findOne({ lmsUserId: item.lmsUserId })
        }
        if (!localStudent && cleanP) {
          localStudent = await Student.findOne({ phone: cleanP })
        }

        if (!localStudent) {
          localStudent = new Student({
            name: item.name,
            phone: cleanP || item.phone,
            email: item.email || '',
            course: item.courseName || '',
            batch: item.batchName || '',
            isAlumni: Boolean(item.isAlumni),
            status: item.isAlumni ? 'alumni' : (item.status || 'active'),
            studentId: item.rollNo || '',
            lmsUserId: item.lmsUserId || '',
            isVerifiedLms: true,
          })
          await localStudent.save()
        } else {
          let updated = false
          if (!localStudent.lmsUserId && item.lmsUserId) {
            localStudent.lmsUserId = item.lmsUserId
            updated = true
          }
          if (item.courseName && !localStudent.course) {
            localStudent.course = item.courseName
            updated = true
          }
          if (item.batchName && !localStudent.batch) {
            localStudent.batch = item.batchName
            updated = true
          }
          if (item.isAlumni !== undefined && localStudent.isAlumni !== item.isAlumni) {
            localStudent.isAlumni = item.isAlumni
            updated = true
          }
          if (!localStudent.isVerifiedLms) {
            localStudent.isVerifiedLms = true
            updated = true
          }
          if (updated) await localStudent.save()
        }

        return {
          id: localStudent._id.toString(),
          lmsUserId: item.lmsUserId,
          name: localStudent.name || item.name,
          phone: localStudent.phone || item.phone,
          email: localStudent.email || item.email,
          course: localStudent.course || item.courseName,
          batch: localStudent.batch || item.batchName,
          rollNo: item.rollNo || localStudent.studentId,
          isAlumni: Boolean(item.isAlumni),
          status: item.status,
          isVerifiedLms: true,
        }
      })
    )

    res.status(200).json({
      success: true,
      count: verifiedStudents.length,
      data: verifiedStudents,
    })
  } catch (error) {
    console.error('[searchLmsStudents] Network/Fetch Error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to communicate with LMS backend API',
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
