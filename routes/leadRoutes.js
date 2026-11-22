import express from 'express'
import multer from 'multer'
import {
  getLeads,
  getSalesRepsList,
  uploadLeads,
  pasteLeads,
  assignLeads,
  autoAssignLeads,
  unassignLeads,
  updateLeadStatus,
  addLeadStep,
  addLeadPaymentReceipt,
  recycleLead,
  bulkRecycleLeads,
  updateLeadProfile,
  deleteLead,
  bulkDeleteLeads,
  createLead,
  resetLeadDatabase,
} from '../controllers/leadController.js'
import { requireAdmin } from '../middleware/authMiddleware.js'

const router = express.Router()

// Multer memory storage configuration for file uploads (xlsx, xls, csv, tsv)
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase()
    if (
      ext.endsWith('.xlsx') ||
      ext.endsWith('.xls') ||
      ext.endsWith('.csv') ||
      ext.endsWith('.tsv') ||
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('excel') ||
      file.mimetype.includes('csv')
    ) {
      cb(null, true)
    } else {
      cb(null, true) // Accept anyway and let XLSX parser handle it gracefully
    }
  },
})

// Query & Read
router.get('/', getLeads)
router.get('/reps', getSalesRepsList)

// Create & Ingestion
router.post('/', createLead)
router.post('/upload', upload.single('file'), uploadLeads)
router.post('/paste', pasteLeads)

// Assignment Engine
router.post('/assign', assignLeads)
router.post('/auto-assign', autoAssignLeads)
router.post('/unassign', unassignLeads)

// Status, Steps & Lost Recycling
router.post('/bulk-delete', requireAdmin, bulkDeleteLeads)
router.post('/bulk-recycle', requireAdmin, bulkRecycleLeads)
router.post('/:id/steps', addLeadStep)
router.post('/:id/receipts', addLeadPaymentReceipt)
router.post('/:id/recycle', requireAdmin, recycleLead)
router.patch('/:id/status', updateLeadStatus)
router.put('/:id/profile', updateLeadProfile)
router.patch('/:id/profile', updateLeadProfile)
router.delete('/:id', requireAdmin, deleteLead)

// Temporary Reset / Clean Lead Database Tool
router.post('/reset-db', resetLeadDatabase)

export default router
