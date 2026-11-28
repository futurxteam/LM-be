import express from 'express'
import {
  getStudents,
  createStudent,
  searchLmsStudents,
  getStudentClassTeacher,
} from '../controllers/studentController.js'

import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/lms-search', searchLmsStudents)
router.get('/class-teacher', getStudentClassTeacher)
router.get('/', getStudents)
router.post('/', createStudent)

export default router

