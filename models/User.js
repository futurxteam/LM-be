import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, default: 'password123' },
    role: { type: String, enum: ['admin', 'sales'], default: 'sales', index: true },
    title: { type: String, default: 'Sales Representative' },
    specialty: { type: String, default: 'Healthcare Admissions' },
    avatar: { type: String, default: 'SR' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
)

export default mongoose.models.User || mongoose.model('User', userSchema)

