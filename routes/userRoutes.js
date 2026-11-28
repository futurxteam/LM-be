import express from 'express'
import {
  getAllUsers,
  createUser,
  updateUser,
  updateUserTelegram,
  testUserTelegram,
  createUserTelegramConnectLink,
  disableOrEnableUser,
  pauseOrResumeUser,
  getUserHistory,
  deleteUser,
} from '../controllers/userController.js'

import { requireAdmin } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/', getAllUsers)
router.get('/:id/history', getUserHistory)
router.post('/', createUser)
router.put('/:id', updateUser)
router.patch('/:id', updateUser)
router.patch('/:id/telegram', updateUserTelegram)
router.post('/:id/telegram/test', testUserTelegram)
router.post('/:id/telegram/connect-link', createUserTelegramConnectLink)
router.patch('/:id/disable', disableOrEnableUser)
router.patch('/:id/pause', pauseOrResumeUser)
router.delete('/:id', deleteUser)

export default router

