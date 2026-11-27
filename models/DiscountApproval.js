import mongoose from 'mongoose'

export const DISCOUNT_REASONS = [
  'Referral',
  'Lump Sum Discount',
  'Spot Admission Discount',
  'Other',
]

const discountApprovalSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true,
    },
    leadName: { type: String, required: true, trim: true },
    leadPhone: { type: String, default: '', trim: true },
    previousStatus: { type: String, default: 'NEW LEAD' },
    targetStatus: {
      type: String,
      enum: ['QUALIFIED BUSINESS', 'CONVERTED BUSINESS', 'ONBOARDED BUSINESS'],
      required: true,
    },
    categoryKey: { type: String, default: '' },
    programId: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseProgram', default: null },
    programName: { type: String, default: '' },
    programVariant: { type: String, default: '' },

    standardCourseFee: { type: Number, required: true, min: 0 },
    requestedAgreedAmount: { type: Number, required: true, min: 0 },
    requestedDiscountAmount: { type: Number, required: true, min: 0 },

    finalAgreedAmount: { type: Number, default: null, min: 0 },
    finalDiscountAmount: { type: Number, default: null, min: 0 },

    discountReason: {
      type: String,
      enum: DISCOUNT_REASONS,
      required: true,
    },
    discountReasonDescription: { type: String, default: '', trim: true },

    // Snapshot of the original step submission payload so approving executes the exact status transition & receipt
    pendingPayload: { type: mongoose.Schema.Types.Mixed, default: {} },

    requestedBy: {
      userId: { type: String, default: '', index: true },
      name: { type: String, default: 'Staff' },
      role: { type: String, default: 'sales' },
    },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'CounselorGroup', default: null },

    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },
    decidedBy: {
      userId: { type: String, default: '' },
      name: { type: String, default: '' },
    },
    decidedAt: { type: Date, default: null },
    adminRemarks: { type: String, default: '', trim: true },

    // For Sales Rep home screen notification banner
    repNotificationRead: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
)

discountApprovalSchema.index({ status: 1, createdAt: -1 })
discountApprovalSchema.index({ 'requestedBy.userId': 1, status: 1, repNotificationRead: 1 })

export default mongoose.models.DiscountApproval ||
  mongoose.model('DiscountApproval', discountApprovalSchema)

