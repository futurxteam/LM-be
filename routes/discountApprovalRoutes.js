import express from 'express'
import {
  getDiscountApprovals,
  getPendingDiscountCount,
  approveDiscountRequest,
  rejectDiscountRequest,
  getMyDiscountNotifications,
  markDiscountNotificationRead,
} from '../controllers/discountApprovalController.js'
import { requireAdmin, requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.get('/approvals', requireAdmin, getDiscountApprovals)
router.get('/approvals/pending-count', requireAdmin, getPendingDiscountCount)
router.post('/approvals/:id/approve', requireAdmin, approveDiscountRequest)
router.post('/approvals/:id/reject', requireAdmin, rejectDiscountRequest)

router.get('/my-notifications', requireAuth, getMyDiscountNotifications)
router.patch('/my-notifications/:id/read', requireAuth, markDiscountNotificationRead)

export default router

