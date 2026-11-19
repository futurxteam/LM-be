import mongoose from 'mongoose'

const selectedFormSchema = new mongoose.Schema(
  {
    formId: { type: String, required: true },
    formName: { type: String, default: 'Meta Lead Form' },
    status: { type: String, default: 'ACTIVE' },
    active: { type: Boolean, default: true },
    leadsCount: { type: Number, default: 0 },
    activatedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
    assignedGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'CounselorGroup', default: null },
    assignedCounselorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    roundRobinIndex: { type: Number, default: 0 },
  },
  { _id: false }
)

const metaIntegrationSchema = new mongoose.Schema(
  {
    pageId: { type: String, default: '' },
    pageName: { type: String, default: 'Futureace Healthcare Academy' },
    accessToken: { type: String, default: '' },
    graphVersion: { type: String, default: 'v21.0' },
    autoSync: { type: Boolean, default: false },
    syncIntervalMinutes: { type: Number, default: 15 },
    lastSyncAt: { type: Date },
    lastSyncStatus: { type: String, enum: ['NEVER', 'SUCCESS', 'ERROR'], default: 'NEVER' },
    lastSyncMessage: { type: String, default: '' },
    lastSuccessfulSyncAt: { type: Date },
    selectedForms: [selectedFormSchema],
    alerts: {
      soundAlert: { type: Boolean, default: true },
      browserNotifications: { type: Boolean, default: true },
      telegramEnabled: { type: Boolean, default: false },
      telegramBotToken: { type: String, default: '' },
      telegramChatId: { type: String, default: '' },
      webhookEnabled: { type: Boolean, default: false },
      webhookUrl: { type: String, default: '' },
    },
  },
  { timestamps: true }
)

export default mongoose.models.MetaIntegration || mongoose.model('MetaIntegration', metaIntegrationSchema)

