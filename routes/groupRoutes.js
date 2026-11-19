import express from 'express'
import {
  getAllGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} from '../controllers/groupController.js'

const router = express.Router()

router.get('/', getAllGroups)
router.post('/', createGroup)
router.put('/:id', updateGroup)
router.delete('/:id', deleteGroup)

export default router
