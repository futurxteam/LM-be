import mongoose from 'mongoose'

const studentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    email: { type: String, default: '', trim: true },
    course: { type: String, default: '', trim: true },
    batch: { type: String, default: '', trim: true },
    isAlumni: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['active', 'alumni', 'completed', 'dropped'],
      default: 'active',
    },
    studentId: { type: String, default: '', trim: true },
    lmsUserId: { type: String, default: '', trim: true, index: true },
    isVerifiedLms: { type: Boolean, default: false },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
)

// Index for search
studentSchema.index({ name: 'text', phone: 'text', course: 'text', batch: 'text' })

export default mongoose.models.Student || mongoose.model('Student', studentSchema)

