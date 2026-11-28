import express from 'express'
import {
  getAllGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} from '../controllers/groupController.js'

import { requireAdmin } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/', getAllGroups)
router.post('/', createGroup)
router.put('/:id', updateGroup)
router.delete('/:id', deleteGroup)

export default router

