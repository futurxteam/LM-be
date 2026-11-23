import express from 'express'
import {
  getAllUsers,
  createUser,
  updateUser,
  disableOrEnableUser,
  pauseOrResumeUser,
  getUserHistory,
  deleteUser,
} from '../controllers/userController.js'

const router = express.Router()

router.get('/', getAllUsers)
router.get('/:id/history', getUserHistory)
router.post('/', createUser)
router.put('/:id', updateUser)
router.patch('/:id', updateUser)
router.patch('/:id/disable', disableOrEnableUser)
router.patch('/:id/pause', pauseOrResumeUser)
router.delete('/:id', deleteUser)

export default router

