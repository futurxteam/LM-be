import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'

function getJwtSecret() {
  return process.env.JWT_SECRET || 'leadpulse_jwt_secret_change_in_production'
}

/**
 * Resolves and cryptographically verifies the calling user from Authorization: Bearer <jwt>
 */
export async function attachUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''

    if (!token) {
      req.user = null
      return next()
    }

    let decoded = null
    try {
      decoded = jwt.verify(token, getJwtSecret())
    } catch (verifyErr) {
      req.user = null
      return next()
    }

    const userId = decoded?.id
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      req.user = null
      return next()
    }

    const userDoc = await User.findById(userId).lean()
    if (!userDoc) {
      req.user = null
      return next()
    }

    // Immediately reject active sessions of disabled accounts on any non-auth route
    if (userDoc.active === false && !req.path.startsWith('/api/auth')) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Your account has been disabled. Please contact your Administrator.',
      })
    }

    req.user = {
      id: userDoc._id.toString(),
      _id: userDoc._id.toString(),
      name: userDoc.name,
      email: userDoc.email,
      role: userDoc.role,
      title: userDoc.title,
      active: userDoc.active !== false,
      groupId: userDoc.groupId ? userDoc.groupId.toString() : null,
      isGroupManager: Boolean(userDoc.isGroupManager),
    }
    return next()
  } catch (err) {
    console.warn('attachUser middleware warning:', err.message)
    req.user = null
    return next()
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please log in again.',
    })
  }
  return next()
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
    })
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin privileges required for this action.',
    })
  }
  return next()
}

export function requireAdminOrManager(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
    })
  }
  if (req.user.role !== 'admin' && req.user.role !== 'manager' && !req.user.isGroupManager) {
    return res.status(403).json({
      success: false,
      message: 'Administrator or Group Manager privileges required.',
    })
  }
  return next()
}

export function isLeadAssignedToUser(lead, user) {
  if (!lead || !user) return false
  if (user.role === 'admin') return true
  if (lead.assignmentStatus !== 'ASSIGNED' || !lead.assignedTo) return false

  const assignedId = lead.assignedTo.repId ? String(lead.assignedTo.repId) : ''
  const userId = String(user.id || user._id || '')
  if (assignedId && userId && assignedId === userId) return true

  // Fallback name check if legacy demo session
  if (
    lead.assignedTo.repName &&
    user.name &&
    lead.assignedTo.repName.toLowerCase() === user.name.toLowerCase()
  ) {
    return true
  }
  return false
}
