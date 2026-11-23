import mongoose from 'mongoose'
import { LEAD_STATUSES } from './CrmSettings.js'

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    author: { type: String, default: 'System' },
    status: { type: String },
    subStatus: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
)

const stepSchema = new mongoose.Schema(
  {
    stepNumber: { type: Number, required: true },
    cycleNumber: { type: Number, default: 1 },
    previousStatus: { type: String, default: 'NEW LEAD' },
    newStatus: { type: String, required: true },
    selectedCategory: { type: String, default: '' },
    selectedCategoryLabel: { type: String, default: '' },
    inquiryIntent: { type: String, default: '' },
    heatTier: { type: String, enum: ['HOT', 'WARM', 'COLD', null], default: null },
    note: { type: String, default: '' },
    lostReason: { type: String, default: '' },
    callbackAt: { type: Date, default: null },
    businessSnapshot: {
      businessProgramId: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseProgram', default: null },
      businessProgramName: { type: String, default: '' },
      businessProgramVariant: { type: String, default: '' },
      courseFees: { type: Number, default: null },
      paidAmount: { type: Number, default: null },
    },
    updatedBy: {
      userId: { type: String, default: '' },
      name: { type: String, default: 'System' },
      role: { type: String, default: 'system' },
    },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
)

const financialAuditSchema = new mongoose.Schema(
  {
    previousValues: {
      businessProgramName: { type: String, default: '' },
      businessProgramVariant: { type: String, default: '' },
      courseFees: { type: Number, default: null },
      paidAmount: { type: Number, default: null },
    },
    newValues: {
      businessProgramName: { type: String, default: '' },
      businessProgramVariant: { type: String, default: '' },
      courseFees: { type: Number, default: null },
      paidAmount: { type: Number, default: null },
    },
    leadStatus: { type: String, default: '' },
    note: { type: String, default: '' },
    changedBy: {
      userId: { type: String, default: '' },
      name: { type: String, default: 'System' },
      role: { type: String, default: 'system' },
    },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
)

const paymentReceiptSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    receiptDate: { type: Date, default: Date.now },
    paymentMode: {
      type: String,
      enum: ['UPI', 'Bank Transfer / NEFT', 'Cash', 'Card', 'Cheque', 'Online Gateway', 'Other'],
      default: 'UPI',
    },
    referenceNo: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    recordedBy: {
      userId: { type: String, default: '' },
      name: { type: String, default: 'System' },
      role: { type: String, default: 'system' },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
)

const ownershipHistorySchema = new mongoose.Schema(
  {
    fromRepId: { type: mongoose.Schema.Types.Mixed, default: null },
    fromRepName: { type: String, default: '' },
    toRepId: { type: mongoose.Schema.Types.Mixed, default: null },
    toRepName: { type: String, default: '' },
    reason: { type: String, default: '' },
    changedBy: {
      userId: { type: String, default: '' },
      name: { type: String, default: 'System' },
      role: { type: String, default: 'system' },
    },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
)

const leadSchema = new mongoose.Schema(
  {
    metaLeadId: { type: String, index: true },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, index: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    qualification: { type: String, default: 'Degree' },
    age: { type: Number, default: null },
    state: { type: String, default: '' },
    otherState: { type: String, default: '' },
    district: { type: String, default: '' },
    courseProgram: { type: String, default: 'Healthcare Management' },
    courseVariant: { type: String, default: '' },
    customerCategory: { type: String, default: 'Ongoing Student' },

    preferredLocation: { type: String, default: 'Not Specified' },
    learningMode: { type: String, default: 'Flexible' },
    interestReason: { type: String, default: '' },
    careerRole: { type: String, default: 'Hospital Administration' },
    platform: { type: String, default: 'Meta' },
    campaignName: { type: String, default: 'Healthcare Management Lead Campaign' },
    adsetName: { type: String, default: '' },
    adName: { type: String, default: '' },
    formName: { type: String, default: 'Healthcare Management Form' },
    createdTime: { type: Date, default: Date.now },
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Assignment state
    assignmentStatus: {
      type: String,
      enum: ['UNASSIGNED', 'ASSIGNED'],
      default: 'UNASSIGNED',
      index: true,
    },
    assignedTo: {
      repId: { type: mongoose.Schema.Types.Mixed, ref: 'User' },
      repName: { type: String },
      repRole: { type: String },
      assignedAt: { type: Date },
    },
    // Permanent record of the very first advisor allocated to this lead (never overwritten on reassignment/disable)
    initialAdvisor: {
      repId: { type: mongoose.Schema.Types.Mixed, ref: 'User' },
      repName: { type: String },
      repRole: { type: String },
      assignedAt: { type: Date },
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CounselorGroup',
      default: null,
    },

    // Primary Lead Lifecycle Status (10 canonical values)
    leadStatus: {
      type: String,
      enum: LEAD_STATUSES,
      default: 'NEW LEAD',
      index: true,
    },
    selectedCategory: { type: String, default: '' },
    selectedCategoryLabel: { type: String, default: '' },
    // FRD Section 4: Active Inquiry Intent Status (only active for HOT / WARM / COLD; archived in lastInquiryIntent otherwise)
    inquiryIntent: { type: String, default: '' },
    lastInquiryIntent: { type: String, default: '' },
    // Admin-only heat classification derived from category/status
    heatTier: {
      type: String,
      enum: ['HOT', 'WARM', 'COLD', null],
      default: null,
      index: true,
    },

    // Legacy Contact Status Workflow (kept auto-synced for backward compatibility)
    status: {
      type: String,
      enum: ['Not Contacted', 'Contacted'],
      default: 'Not Contacted',
      index: true,
    },
    subStatus: { type: String, default: 'New Lead In Pool' },
    callAttempts: { type: Number, default: 0 },
    callbackAt: { type: Date, default: null },

    // Cycle & Recyclable Lost Tracking
    cycleNumber: { type: Number, default: 1 },
    lostCycleCount: { type: Number, default: 0, index: true },
    lostReason: { type: String, default: '' },
    lastLostBy: {
      repId: { type: mongoose.Schema.Types.Mixed, default: null },
      repName: { type: String, default: '' },
      lostAt: { type: Date, default: null },
    },
    canRecycle: { type: Boolean, default: false, index: true },
    isCycleEnded: { type: Boolean, default: false, index: true },
    cycleEndReason: {
      type: String,
      enum: ['NON_PROSPECT', 'CONVERTED', 'ONBOARDED', 'MAX_LOST_REACHED', null],
      default: null,
    },

    // Conditional Business & Financial Fields (Preserved on backward transitions)
    businessProgramId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CourseProgram',
      default: null,
    },
    businessProgramName: { type: String, default: '' },
    businessProgramVariant: { type: String, default: '' },
    courseFees: { type: Number, default: null, min: 0 },
    paidAmount: { type: Number, default: null, min: 0 },
    overpaidFlag: { type: Boolean, default: false },
    paymentReceipts: [paymentReceiptSchema],
    milestoneHistory: {
      qualifiedAt: { type: Date, default: null },
      convertedAt: { type: Date, default: null },
      onboardedAt: { type: Date, default: null },
    },

    // Lifecycle Completion / Dropped Tracking (used by capacity-aware allocation)
    isDropped: { type: Boolean, default: false, index: true },
    isCompleted: { type: Boolean, default: false, index: true },
    droppedReason: { type: String, default: '' },
    completedAt: { type: Date, default: null },

    // Step-by-Step Progression, Financial Audit, Ownership Audit & Notes
    steps: [stepSchema],
    financialHistory: [financialAuditSchema],
    ownershipHistory: [ownershipHistorySchema],
    notes: [noteSchema],

    // Referral association
    referral: {
      isReferred: { type: Boolean, default: false, index: true },
      referralId: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },
      referralType: { type: String, enum: ['lead', 'student', 'alumni', ''], default: '' },
      referrerName: { type: String, default: '' },
      referrerPhone: { type: String, default: '' },
      referrerCourse: { type: String, default: '' },
      referrerBatch: { type: String, default: '' },
    },
  },
  { timestamps: true }
)

// Compound index for fast deduplication checks
leadSchema.index({ phone: 1, email: 1 })

export default mongoose.models.Lead || mongoose.model('Lead', leadSchema)
