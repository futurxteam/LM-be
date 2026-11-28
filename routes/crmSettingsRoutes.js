import express from 'express'
import {
  getCrmMeta,
  getCrmSettings,
  updateCrmSettings,
  getCoursePrograms,
  createCourseProgram,
  updateCourseProgram,
  deleteCourseProgram,
  testCrmTelegram,
} from '../controllers/crmSettingsController.js'
import { requireAdmin, requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

// Shared lifecycle options (heatTier stripped for non-admin)
router.get('/meta', requireAuth, getCrmMeta)
router.get('/programs', requireAuth, getCoursePrograms)

// Admin-only settings & Program Master management
router.get('/settings', requireAdmin, getCrmSettings)
router.put('/settings', requireAdmin, updateCrmSettings)
router.post('/telegram/test', requireAdmin, testCrmTelegram)
router.post('/programs', requireAdmin, createCourseProgram)
router.put('/programs/:id', requireAdmin, updateCourseProgram)
router.delete('/programs/:id', requireAdmin, deleteCourseProgram)

export default router
