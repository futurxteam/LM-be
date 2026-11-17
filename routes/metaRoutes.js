import express from 'express'
import {
  getMetaConfig,
  saveMetaConfig,
  fetchPageForms,
  saveSelectedForms,
  syncLeads,
  testTelegramAlert,
  testWebhookAlert,
  previewFormLeads,
  importSelectedLeads,
} from '../controllers/metaController.js'

const router = express.Router()

router.get('/config', getMetaConfig)
router.post('/config', saveMetaConfig)
router.post('/fetch-forms', fetchPageForms)
router.post('/save-forms', saveSelectedForms)
router.post('/sync', syncLeads)
router.post('/sync-leads', syncLeads) // Alias for convenience
router.post('/test-telegram', testTelegramAlert)
router.post('/test-webhook', testWebhookAlert)
router.post('/preview-form-leads', previewFormLeads)
router.post('/import-selected-leads', importSelectedLeads)

export default router

