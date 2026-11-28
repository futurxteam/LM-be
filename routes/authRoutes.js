import express from 'express'
import {
  login,
  getMe,
  getMyTelegramProfile,
  updateMyProfile,
  testMyTelegram,
} from '../controllers/authController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.post('/login', login)
router.get('/me', requireAuth, getMe)
router.get('/profile', requireAuth, getMyTelegramProfile)
router.put('/profile', requireAuth, updateMyProfile)
router.post('/profile/telegram-test', requireAuth, testMyTelegram)

export default router

