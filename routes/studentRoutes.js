import express from 'express'
import { getStudents, createStudent, searchLmsStudents } from '../controllers/studentController.js'

const router = express.Router()

router.get('/lms-search', searchLmsStudents)
router.get('/', getStudents)
router.post('/', createStudent)

export default router

