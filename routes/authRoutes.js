import express from 'express'
import {
  login,
  getMe,
  getMyTelegramProfile,
  updateMyProfile,
  testMyTelegram,
  getMyTelegramConnectLink,
  checkMyTelegramLinkStatus,
} from '../controllers/authController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.post('/login', login)
router.get('/me', requireAuth, getMe)
router.get('/profile', requireAuth, getMyTelegramProfile)
router.put('/profile', requireAuth, updateMyProfile)
router.post('/profile/telegram-test', requireAuth, testMyTelegram)
router.get('/telegram/connect-link', requireAuth, getMyTelegramConnectLink)
router.get('/telegram/status', requireAuth, checkMyTelegramLinkStatus)

export default router

