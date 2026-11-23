import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

import express from 'express'
import cors from 'cors'
import { connectDB, dbConfig } from './config/db.js'

// Route Imports
import authRoutes from './routes/authRoutes.js'
import leadRoutes from './routes/leadRoutes.js'
import statsRoutes from './routes/statsRoutes.js'
import metaRoutes from './routes/metaRoutes.js'
import userRoutes from './routes/userRoutes.js'
import groupRoutes from './routes/groupRoutes.js'
import crmSettingsRoutes from './routes/crmSettingsRoutes.js'
import studentRoutes from './routes/studentRoutes.js'
import referralRoutes from './routes/referralRoutes.js'
import { attachUser } from './middleware/authMiddleware.js'
import { startMetaCron } from './services/metaCron.js'

const app = express()
const PORT = dbConfig.port || process.env.PORT || 5000

// Connect to MongoDB & Start Background Services
connectDB().then(() => {
  startMetaCron()
}).catch(err => {
  console.error('Failed to connect to DB:', err.message)
})

// CORS Configuration
const allowedOrigins = new Set([
  'https://sales.futureaceacademy.com',
  'http://sales.futureaceacademy.com',
  'https://www.sales.futureaceacademy.com',

  ...(process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : []),
])

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser / server-to-server requests (Meta webhooks, health checks, curl)
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true)
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204,
}

// Middlewares
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json())
app.use(attachUser)

// Mount Modular Routes
app.use('/api/auth', authRoutes)
app.use('/api/leads', leadRoutes)
app.use('/api/stats', statsRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/users', userRoutes)
app.use('/api/groups', groupRoutes)
app.use('/api/crm', crmSettingsRoutes)
app.use('/api/students', studentRoutes)
app.use('/api/referrals', referralRoutes)

// Health Check
app.get('/', (req, res) => {
  res.send({ status: 'LeadPulse CRM API Server is active with MongoDB' })
})

app.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`)
})
