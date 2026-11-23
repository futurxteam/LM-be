import mongoose from 'mongoose'

const referralSchema = new mongoose.Schema(
  {
    referralType: {
      type: String,
      enum: ['lead', 'student', 'alumni'],
      required: true,
      index: true,
    },
    referredLeadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true,
    },
    referrerLeadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      default: null,
      index: true,
    },
    referrerStudentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      default: null,
      index: true,
    },

    // Referrer snapshot
    referrerName: { type: String, required: true, trim: true },
    referrerPhone: { type: String, default: '', trim: true },
    referrerEmail: { type: String, default: '', trim: true },
    referrerCourse: { type: String, default: '', trim: true },
    referrerBatch: { type: String, default: '', trim: true },
    isAlumni: { type: Boolean, default: false },

    // Referred Candidate snapshot
    referredCandidateName: { type: String, required: true, trim: true },
    referredCandidatePhone: { type: String, default: '', trim: true },
    referredCandidateCourse: { type: String, default: '', trim: true },

    // Lead Lifecycle Sync
    leadStatus: { type: String, default: 'Not Contacted' },
    isQualified: { type: Boolean, default: false },
    isConverted: { type: Boolean, default: false },
    isOnboarded: { type: Boolean, default: false },
    courseFees: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    assignedCounselor: {
      repId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      repName: { type: String, default: '' },
    },
    convertedAt: { type: Date, default: null },
    onboardedAt: { type: Date, default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
)

referralSchema.index({ createdAt: -1 })
referralSchema.index({ referralType: 1, createdAt: -1 })
referralSchema.index({ referrerName: 'text', referredCandidateName: 'text' })

export default mongoose.models.Referral || mongoose.model('Referral', referralSchema)

