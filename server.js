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
import { startMetaCron } from './services/metaCron.js'

const app = express()
const PORT = dbConfig.port || process.env.PORT || 5000

// Connect to MongoDB & Start Background Services
connectDB().then(() => {
  startMetaCron()
}).catch(err => {
  console.error('Failed to connect to DB:', err.message)
})

// Middlewares
app.use(cors())
app.use(express.json())

// Mount Modular Routes
app.use('/api/auth', authRoutes)
app.use('/api/leads', leadRoutes)
app.use('/api/stats', statsRoutes)
app.use('/api/meta', metaRoutes)

// Health Check
app.get('/', (req, res) => {
  res.send({ status: 'LeadPulse CRM API Server is active with MongoDB' })
})

app.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`)
})
