import mongoose from 'mongoose'

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

const leadSchema = new mongoose.Schema(
  {
    metaLeadId: { type: String, index: true },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, index: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    qualification: { type: String, default: 'Degree' },
    age: { type: Number, default: null },
    state: { type: String, default: 'Kerala' },
    otherState: { type: String, default: '' },
    district: { type: String, default: 'Ernakulam' },
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
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CounselorGroup',
      default: null,
    },

    // Contact Status Workflow
    status: {
      type: String,
      enum: ['Not Contacted', 'Contacted'],
      default: 'Not Contacted',
      index: true,
    },
    subStatus: { type: String, default: 'New Lead In Pool' },
    callAttempts: { type: Number, default: 0 },
    callbackAt: { type: Date, default: null },

    // Lifecycle Completion / Dropped Tracking
    isDropped: { type: Boolean, default: false, index: true },
    isCompleted: { type: Boolean, default: false, index: true },
    droppedReason: { type: String, default: '' },
    completedAt: { type: Date, default: null },

    notes: [noteSchema],
  },
  { timestamps: true }
)

// Compound index for fast deduplication checks
leadSchema.index({ phone: 1, email: 1 })

export default mongoose.models.Lead || mongoose.model('Lead', leadSchema)

