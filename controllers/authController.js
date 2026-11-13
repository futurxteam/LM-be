// Authentication Controller (MongoDB-backed User Authentication)
import User from '../models/User.js'

export const login = async (req, res) => {
  try {
    const { email, role } = req.body

    let user = null

    if (email) {
      user = await User.findOne({ email: email.toLowerCase() })
    }

    if (!user) {
      const searchRole = role || (email && email.toLowerCase().includes('admin') ? 'admin' : 'sales')
      user = await User.findOne({ role: searchRole })
    }

    if (!user) {
      user = await User.findOne()
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'No users found in database' })
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
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
