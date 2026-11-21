import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, default: 'password123' },
    role: { type: String, enum: ['admin', 'sales'], default: 'sales', index: true },
    title: { type: String, default: 'Admissions Counselor' },
    specialty: { type: String, default: 'Healthcare Admissions' },
    avatar: { type: String, default: 'AC' },
    active: { type: Boolean, default: true },
    disabledAt: { type: Date, default: null },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'CounselorGroup', default: null },
    isGroupManager: { type: Boolean, default: false },
  },
  { timestamps: true }
)

export default mongoose.models.User || mongoose.model('User', userSchema)

