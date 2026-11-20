import mongoose from 'mongoose'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

export const dbConfig = {
  url: process.env.DATABASE_URL,
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET || 'leadpulse_default_jwt_secret',
}

export async function connectDB() {
  try {
    console.log('--------------------------------------------------')
    console.log('📡 Connecting to MongoDB Atlas...')

    if (!dbConfig.url) {
      throw new Error(`DATABASE_URL is not defined in ${path.join(__dirname, '../.env')}`)
    }

    const conn = await mongoose.connect(dbConfig.url)
    console.log(`✅ MongoDB Connected: ${conn.connection.host} (DB: ${conn.connection.name})`)
    console.log('--------------------------------------------------')
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message)
    console.log('--------------------------------------------------')
  }
}
