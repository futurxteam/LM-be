// Authentication Controller (MongoDB-backed User Authentication with bcrypt + signed JWT)
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { getTelegramBotStatus, sendTestTelegramAlert } from '../services/telegramService.js'

const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$/

function formatAuthUser(user) {
  return {
    id: user._id.toString(),
    _id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    title: user.title,
    specialty: user.specialty,
    avatar: user.avatar,
    active: user.active !== false,
    groupId: user.groupId ? user.groupId.toString() : null,
    isGroupManager: Boolean(user.isGroupManager),
    receiveLeads: user.receiveLeads !== false,
    telegramChatId: user.telegramChatId || '',
    telegramNotificationsEnabled: Boolean(user.telegramNotificationsEnabled),
    telegramPreferences: {
      newLead: user.telegramPreferences?.newLead !== false,
      leadAssigned: user.telegramPreferences?.leadAssigned !== false,
      discountRequested: user.telegramPreferences?.discountRequested !== false,
      discountDecision: user.telegramPreferences?.discountDecision !== false,
      businessMilestone: user.telegramPreferences?.businessMilestone !== false,
    },
  }
}

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
      user: formatAuthUser(user),
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

export const getMyTelegramProfile = async (req, res) => {
  try {
    const botStatus = await getTelegramBotStatus()
    return res.status(200).json({
      success: true,
      user: req.user,
      telegramBotStatus: botStatus,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

export const updateMyProfile = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id
    const isAdmin = req.user?.role === 'admin'
    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' })
    }

    const { telegramChatId, telegramNotificationsEnabled, telegramPreferences } = req.body || {}

    if (telegramChatId !== undefined) {
      user.telegramChatId = String(telegramChatId || '').trim()
    }

    // Only Administrators can enable/disable Telegram notifications or modify alert preferences
    if (isAdmin) {
      if (telegramNotificationsEnabled !== undefined) {
        const nextEnabled = Boolean(telegramNotificationsEnabled)
        if (nextEnabled && !String(user.telegramChatId || '').trim()) {
          return res.status(400).json({
            success: false,
            message: 'Please enter your Telegram Chat ID before enabling notifications.',
          })
        }
        user.telegramNotificationsEnabled = nextEnabled
      }

      if (telegramPreferences && typeof telegramPreferences === 'object') {
        const current = user.telegramPreferences || {}
        user.telegramPreferences = {
          newLead: telegramPreferences.newLead !== undefined ? Boolean(telegramPreferences.newLead) : current.newLead !== false,
          leadAssigned: telegramPreferences.leadAssigned !== undefined ? Boolean(telegramPreferences.leadAssigned) : current.leadAssigned !== false,
          discountRequested: telegramPreferences.discountRequested !== undefined ? Boolean(telegramPreferences.discountRequested) : current.discountRequested !== false,
          discountDecision: telegramPreferences.discountDecision !== undefined ? Boolean(telegramPreferences.discountDecision) : current.discountDecision !== false,
          businessMilestone: telegramPreferences.businessMilestone !== undefined ? Boolean(telegramPreferences.businessMilestone) : current.businessMilestone !== false,
        }
        user.markModified('telegramPreferences')
      }
    }

    await user.save()

    return res.status(200).json({
      success: true,
      message: isAdmin
        ? 'Profile & Telegram notification settings saved.'
        : 'Telegram Chat ID saved to your profile.',
      user: formatAuthUser(user),
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

export const testMyTelegram = async (req, res) => {
  try {
    const { chatId } = req.body || {}
    const targetChatId = String(chatId || req.user?.telegramChatId || '').trim()
    if (!targetChatId) {
      return res.status(400).json({
        success: false,
        message: 'Please enter your Telegram Chat ID first.',
      })
    }

    const result = await sendTestTelegramAlert({
      chatId: targetChatId,
      customTemplate: `Futureace Academy CRM — Test Notification\nHi ${req.user?.name || 'User'}, your personal Telegram alerts are connected!`,
    })

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: `Telegram delivery failed: ${result.error}`,
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Test message delivered to your Telegram!',
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
