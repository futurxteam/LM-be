import express from 'express'
import { getStats, getAdvancedReports, getFrdReports } from '../controllers/statsController.js'
import { requireAdmin, requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.get('/', getStats)
router.get('/advanced', requireAdmin, getAdvancedReports)
router.get('/frd-reports', requireAuth, getFrdReports)

export default router
