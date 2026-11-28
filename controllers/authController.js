// Authentication Controller (MongoDB-backed User Authentication with bcrypt + signed JWT)
import jwt from 'jsonwebtoken'
import User from '../models/User.js'

const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$/

function getJwtSecret() {
  return process.env.JWT_SECRET || 'leadpulse_jwt_secret_change_in_production'
}

export const login = async (req, res) => {
  try {
    const { email, password } = req.body || {}
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''

    if (!normalizedEmail || !password || typeof password !== 'string') {
      return res.status(401).json({
        success: false,
        message: 'Email and password are required.',
      })
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      })
    }

    // Verify password against bcrypt hash in DB
    const isMatch = await user.comparePassword(password)
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      })
    }

    // Transparently upgrade legacy plaintext password to bcrypt hash on successful login
    if (!BCRYPT_HASH_REGEX.test(user.password)) {
      user.markModified('password')
      await user.save()
    }

    // Block disabled staff from logging in
    if (user.active === false) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Your account has been disabled. Please contact your Administrator.',
      })
    }

    const token = jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      getJwtSecret(),
      { expiresIn: '7d' }
    )

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        title: user.title,
        specialty: user.specialty,
        avatar: user.avatar,
        active: user.active !== false,
        groupId: user.groupId || null,
        isGroupManager: Boolean(user.isGroupManager),
        receiveLeads: user.receiveLeads !== false,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

export const getMe = async (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user,
  })
}
