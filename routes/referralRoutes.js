import express from 'express'
import { getReferrals, getReferralStats } from '../controllers/referralController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.get('/', requireAuth, getReferrals)
router.get('/stats', requireAuth, getReferralStats)

export default router

