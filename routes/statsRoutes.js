import express from 'express'
import { getStats, getAdvancedReports } from '../controllers/statsController.js'
import { requireAdmin } from '../middleware/authMiddleware.js'

const router = express.Router()

router.get('/', getStats)
router.get('/advanced', requireAdmin, getAdvancedReports)

export default router
