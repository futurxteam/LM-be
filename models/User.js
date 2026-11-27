import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$/

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, default: 'password123' },
    role: { type: String, enum: ['admin', 'sales', 'manager'], default: 'sales', index: true },
    title: { type: String, default: 'Admissions Counselor' },
    specialty: { type: String, default: 'Healthcare Admissions' },
    avatar: { type: String, default: 'AC' },
    active: { type: Boolean, default: true },
    disabledAt: { type: Date, default: null },
    isPaused: { type: Boolean, default: false },
    pauseStartDate: { type: Date, default: null },
    pauseEndDate: { type: Date, default: null },
    pauseReason: { type: String, default: '' },
    pausedAt: { type: Date, default: null },
    pausedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    pauseHistory: [
      {
        startDate: { type: Date, default: null },
        endDate: { type: Date, default: null },
        reason: { type: String, default: '' },
        pausedAt: { type: Date, default: Date.now },
        resumedAt: { type: Date, default: null },
      },
    ],
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'CounselorGroup', default: null },
    isGroupManager: { type: Boolean, default: false },
    receiveLeads: { type: Boolean, default: true },
  },
  { timestamps: true }
)

// Hash password automatically before saving if modified and not already a bcrypt hash
userSchema.pre('save', async function () {
  if (!this.isModified('password') || !this.password) return
  if (BCRYPT_HASH_REGEX.test(this.password)) return
  const salt = await bcrypt.genSalt(10)
  this.password = await bcrypt.hash(this.password, salt)
})

// Compare candidate password against stored hash (with legacy plaintext fallback)
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!candidatePassword || !this.password) return false
  if (BCRYPT_HASH_REGEX.test(this.password)) {
    return bcrypt.compare(String(candidatePassword), this.password)
  }
  return String(candidatePassword) === String(this.password)
}

export default mongoose.models.User || mongoose.model('User', userSchema)

