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
import {
  verifyMetaWebhook,
  handleMetaWebhookEvent,
  subscribePageToWebhook,
} from '../controllers/metaWebhookController.js'
import { requireAdmin } from '../middleware/authMiddleware.js'

const router = express.Router()

// Real-Time Meta Lead Ads Webhook (MUST stay public for Meta servers)
router.get('/webhook', verifyMetaWebhook)
router.post('/webhook', handleMetaWebhookEvent)

// Admin-only Meta Graph API configuration & lead sync endpoints
router.use(requireAdmin)
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
router.post('/subscribe-page-webhook', subscribePageToWebhook)

export default router

