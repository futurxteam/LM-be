import mongoose from 'mongoose'

const counselorGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Group name is required'],
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    memberIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
)

const CounselorGroup = mongoose.model('CounselorGroup', counselorGroupSchema)
export default CounselorGroup
