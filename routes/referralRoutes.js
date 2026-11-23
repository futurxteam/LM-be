import express from 'express'
import { getReferrals, getReferralStats } from '../controllers/referralController.js'

const router = express.Router()

router.get('/', getReferrals)
router.get('/stats', getReferralStats)

export default router

