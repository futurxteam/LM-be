import mongoose from 'mongoose'

const courseProgramSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    code: { type: String, trim: true, default: '' },
    variants: { type: [String], default: [] },
    defaultFee: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
)

const CourseProgram =
  mongoose.models.CourseProgram || mongoose.model('CourseProgram', courseProgramSchema)

export const DEFAULT_COURSE_PROGRAMS = [
  {
    name: 'Healthcare Management',
    code: 'HCM',
    variants: [
      'Advanced Diploma HM & HA',
      'PG Diploma in HM & AI',
      'PG Diploma in SHM & AI',
    ],
    defaultFee: 0,
    active: true,
  },
  {
    name: 'GDA',
    code: 'GDA',
    variants: [],
    defaultFee: 0,
    active: true,
  },
  {
    name: 'Geriatric Caregiver',
    code: 'GCG',
    variants: [],
    defaultFee: 0,
    active: true,
  },
]

export async function ensureDefaultPrograms() {
  const count = await CourseProgram.countDocuments()
  if (count === 0) {
    await CourseProgram.insertMany(DEFAULT_COURSE_PROGRAMS)
  }
  return CourseProgram.find().sort({ active: -1, name: 1 })
}

export default CourseProgram
