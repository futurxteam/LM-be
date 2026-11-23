import mongoose from 'mongoose'
import User from '../models/User.js'

/**
 * Resolves the calling user from Authorization: Bearer <token>
 * Token formats supported by this CRM:
 * - jwt_<role>_session_<userObjectId>
 * - demo_token_<role>
 */
export async function attachUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''

    if (!token) {
      req.user = null
      return next()
    }

    const sessionMatch = token.match(/^jwt_(admin|sales|manager)_session_(.+)$/)
    if (sessionMatch) {
      const [, roleFromToken, userId] = sessionMatch
      if (mongoose.Types.ObjectId.isValid(userId)) {
        const userDoc = await User.findById(userId).lean()
        if (userDoc) {
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
        }
      }
      req.user = {
        id: userId,
        _id: userId,
        name: roleFromToken === 'admin' ? 'Administrator' : 'Sales Counselor',
        role: roleFromToken,
      }
      return next()
    }

    const demoMatch = token.match(/^demo_token_(admin|sales)$/)
    if (demoMatch) {
      const role = demoMatch[1]
      const fallbackUser = await User.findOne({ role }).lean()
      req.user = fallbackUser
        ? {
            id: fallbackUser._id.toString(),
            _id: fallbackUser._id.toString(),
            name: fallbackUser.name,
            email: fallbackUser.email,
            role: fallbackUser.role,
            title: fallbackUser.title,
          }
        : {
            id: role === 'admin' ? 'admin_01' : 'sales_01',
            _id: role === 'admin' ? 'admin_01' : 'sales_01',
            name: role === 'admin' ? 'Administrator' : 'Sales Counselor',
            role,
          }
      return next()
    }

    req.user = null
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
