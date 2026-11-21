// Authentication Controller (MongoDB-backed User Authentication)
import User from '../models/User.js'

export const login = async (req, res) => {
  try {
    const { email, role } = req.body || {}
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''

    let user = null

    if (normalizedEmail) {
      user = await User.findOne({ email: normalizedEmail })
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or account not found.',
        })
      }
    } else {
      const searchRole = role || 'sales'
      user = await User.findOne({ role: searchRole, active: { $ne: false } })
      if (!user) {
        user = await User.findOne({ active: { $ne: false } })
      }
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'No active users found in database' })
    }

    // Block disabled staff from logging in
    if (user.active === false) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Your account has been disabled. Please contact your Administrator.',
      })
    }

    const token = `jwt_${user.role}_session_${user._id}`

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
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
