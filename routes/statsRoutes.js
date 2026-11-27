import express from 'express'
import {
  getStats,
  getAdvancedReports,
  getFrdReports,
  getDiscountReport,
  getResponseSlaReport,
} from '../controllers/statsController.js'
import { requireAdminOrManager, requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.get('/', getStats)
router.get('/advanced', requireAdminOrManager, getAdvancedReports)
router.get('/frd-reports', requireAuth, getFrdReports)
router.get('/discounts', requireAdminOrManager, getDiscountReport)
router.get('/response-sla', requireAdminOrManager, getResponseSlaReport)

export default router
