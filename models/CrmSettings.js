import mongoose from 'mongoose'

export const LEAD_STATUSES = [
  'NEW LEAD',
  'HOT',
  'WARM',
  'COLD',
  'LOST',
  'NON-CONNECT',
  'NON PROSPECT',
  'QUALIFIED BUSINESS',
  'CONVERTED BUSINESS',
  'ONBOARDED BUSINESS',
]

export const BUSINESS_STATUSES = [
  'QUALIFIED BUSINESS',
  'CONVERTED BUSINESS',
  'ONBOARDED BUSINESS',
]

export const DEFAULT_OUTCOME_CATEGORIES = [
  // Positive interest -> HOT
  { key: 'ready_to_join', label: 'Ready to Join / High Intent', leadStatus: 'HOT', heatTier: 'HOT', group: 'Positive Interest', active: true },
  { key: 'fee_discussed_positive', label: 'Fee Discussed – Positive', leadStatus: 'HOT', heatTier: 'HOT', group: 'Positive Interest', active: true },
  { key: 'campus_visit_booked', label: 'Campus / Counseling Visit Booked', leadStatus: 'HOT', heatTier: 'HOT', group: 'Positive Interest', active: true },
  { key: 'admission_form_requested', label: 'Requested Admission Form', leadStatus: 'HOT', heatTier: 'HOT', group: 'Positive Interest', active: true },

  // Moderate / Mediate -> WARM
  { key: 'interested_needs_time', label: 'Interested – Needs Time to Decide', leadStatus: 'WARM', heatTier: 'WARM', group: 'Moderate / Follow-up', active: true },
  { key: 'sent_brochure', label: 'Brochure / Curriculum Sent', leadStatus: 'WARM', heatTier: 'WARM', group: 'Moderate / Follow-up', active: true },
  { key: 'consulting_family', label: 'Consulting Family / Sponsor', leadStatus: 'WARM', heatTier: 'WARM', group: 'Moderate / Follow-up', active: true },
  { key: 'callback_scheduled', label: 'Callback Scheduled', leadStatus: 'WARM', heatTier: 'WARM', group: 'Moderate / Follow-up', active: true },

  // Low / Delayed / Non-Negative -> COLD
  { key: 'future_intake', label: 'Interested for Future Batch / Intake', leadStatus: 'COLD', heatTier: 'COLD', group: 'Low / Delayed Interest', active: true },
  { key: 'low_urgency', label: 'Low Urgency / Just Exploring', leadStatus: 'COLD', heatTier: 'COLD', group: 'Low / Delayed Interest', active: true },
  { key: 'budget_exploring', label: 'Budget Constraint – Nurturing', leadStatus: 'COLD', heatTier: 'COLD', group: 'Low / Delayed Interest', active: true },
  { key: 'delayed_response', label: 'Slow / Delayed Response', leadStatus: 'COLD', heatTier: 'COLD', group: 'Low / Delayed Interest', active: true },

  // Not Connected -> NON-CONNECT (Heat: COLD, separate from LOST)
  { key: 'ringing_no_answer', label: 'Ringing / No Answer', leadStatus: 'NON-CONNECT', heatTier: 'COLD', group: 'Non-Connect', active: true },
  { key: 'switched_off', label: 'Switched Off / Out of Reach', leadStatus: 'NON-CONNECT', heatTier: 'COLD', group: 'Non-Connect', active: true },
  { key: 'busy_call_later', label: 'Line Busy / Call Later', leadStatus: 'NON-CONNECT', heatTier: 'COLD', group: 'Non-Connect', active: true },
  { key: 'whatsapp_only_pending', label: 'WhatsApp Sent – Awaiting Reply', leadStatus: 'NON-CONNECT', heatTier: 'COLD', group: 'Non-Connect', active: true },

  // Non Prospect -> NON PROSPECT (Heat: COLD, End of Cycle)
  { key: 'not_eligible', label: 'Not Eligible for Program', leadStatus: 'NON PROSPECT', heatTier: 'COLD', group: 'Non Prospect (End of Cycle)', active: true },
  { key: 'wrong_course_domain', label: 'Looking for Different Domain / Job Only', leadStatus: 'NON PROSPECT', heatTier: 'COLD', group: 'Non Prospect (End of Cycle)', active: true },
  { key: 'invalid_wrong_number', label: 'Wrong / Invalid Contact Number', leadStatus: 'NON PROSPECT', heatTier: 'COLD', group: 'Non Prospect (End of Cycle)', active: true },
  { key: 'duplicate_spam', label: 'Duplicate / Spam Inquiry', leadStatus: 'NON PROSPECT', heatTier: 'COLD', group: 'Non Prospect (End of Cycle)', active: true },

  // Lost -> LOST (Heat: COLD, Recyclable up to maxLostCycles)
  { key: 'lost_declined', label: 'Not Proceeding at This Time (Lost)', leadStatus: 'LOST', heatTier: 'COLD', group: 'Lost (Recyclable)', active: true },

  // Business Milestones -> HOT (requires Program, Course Fees, Paid Amount)
  { key: 'qualified_business', label: 'Qualified Business (Admission Committed)', leadStatus: 'QUALIFIED BUSINESS', heatTier: 'HOT', group: 'Business Milestones', active: true },
  { key: 'converted_business', label: 'Converted Business (Fee Paid / Seat Confirmed)', leadStatus: 'CONVERTED BUSINESS', heatTier: 'HOT', group: 'Business Milestones', active: true },
  { key: 'onboarded_business', label: 'Onboarded Business (Admission Completed)', leadStatus: 'ONBOARDED BUSINESS', heatTier: 'HOT', group: 'Business Milestones', active: true },
]

export const DEFAULT_LOST_REASONS = [
  'Fee / Budget Issue',
  'Joined Another Institute',
  'Location / Relocation Constraint',
  'Postponed Plans Indefinitely',
  'No Longer Interested',
  'Family / Personal Reason',
  'Other',
]

const outcomeCategorySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    leadStatus: { type: String, enum: LEAD_STATUSES, required: true },
    heatTier: { type: String, enum: ['HOT', 'WARM', 'COLD', null], default: null },
    group: { type: String, default: 'General' },
    active: { type: Boolean, default: true },
  },
  { _id: false }
)

const crmSettingsSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: 'default', unique: true },
    maxLostCycles: { type: Number, default: 3, min: 1, max: 20 },
    lostRecycleMode: {
      type: String,
      enum: ['manual', 'auto_pool'],
      default: 'manual',
    },
    requireBusinessFields: { type: Boolean, default: true },
    allowAdminBusinessFieldException: { type: Boolean, default: true },
    allowSalesFinancialEdit: { type: Boolean, default: true },
    outcomeCategories: { type: [outcomeCategorySchema], default: () => DEFAULT_OUTCOME_CATEGORIES },
    lostReasons: { type: [String], default: () => DEFAULT_LOST_REASONS },
  },
  { timestamps: true }
)

const CrmSettings =
  mongoose.models.CrmSettings || mongoose.model('CrmSettings', crmSettingsSchema)

export async function getOrCreateCrmSettings() {
  let settings = await CrmSettings.findOne({ singletonKey: 'default' })
  if (!settings) {
    settings = await CrmSettings.create({
      singletonKey: 'default',
      maxLostCycles: 3,
      lostRecycleMode: 'manual',
      requireBusinessFields: true,
      allowAdminBusinessFieldException: true,
      allowSalesFinancialEdit: true,
      outcomeCategories: DEFAULT_OUTCOME_CATEGORIES,
      lostReasons: DEFAULT_LOST_REASONS,
    })
  }
  return settings
}

export function deriveHeatTierFromStatus(leadStatus) {
  switch (leadStatus) {
    case 'HOT':
    case 'QUALIFIED BUSINESS':
    case 'CONVERTED BUSINESS':
    case 'ONBOARDED BUSINESS':
      return 'HOT'
    case 'WARM':
      return 'WARM'
    case 'COLD':
    case 'NON-CONNECT':
    case 'NON PROSPECT':
    case 'LOST':
      return 'COLD'
    default:
      return null
  }
}

export default CrmSettings
