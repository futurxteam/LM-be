import mongoose from 'mongoose'
import User from '../models/User.js'
import Lead from '../models/Lead.js'

/**
 * Generate 2-letter avatar initials from full name
 */
function generateAvatar(name) {
  if (!name) return 'SR'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// -------------------------------------------------------------
// GET /api/users - List all users with real-time lead analytics
// -------------------------------------------------------------
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().sort({ role: 1, createdAt: -1 }).lean()

    const usersWithStats = await Promise.all(
      users.map(async u => {
        const userId = u._id
        const totalAssigned = await Lead.countDocuments({
          $or: [
            { 'assignedTo.repId': userId },
            { 'assignedTo.repId': userId.toString() },
          ],
        })

        const contactedCount = await Lead.countDocuments({
          $or: [
            { 'assignedTo.repId': userId },
            { 'assignedTo.repId': userId.toString() },
          ],
          status: 'Contacted',
        })

        const enrolledCount = await Lead.countDocuments({
          $or: [
            { 'assignedTo.repId': userId },
            { 'assignedTo.repId': userId.toString() },
          ],
          subStatus: /enrolled|won|admitted/i,
        })

        const contactRate = totalAssigned > 0 ? Math.round((contactedCount / totalAssigned) * 100) : 0

        return {
          id: u._id.toString(),
          _id: u._id.toString(),
          name: u.name,
          email: u.email,
          role: u.role,
          title: u.title || (u.role === 'admin' ? 'Administrator' : 'Admissions Counselor'),
          specialty: u.specialty || 'Healthcare Admissions',
          avatar: u.avatar || generateAvatar(u.name),
          active: u.active !== false,
          totalAssigned,
          contactedCount,
          enrolledCount,
          contactRate,
          createdAt: u.createdAt,
        }
      })
    )

    res.status(200).json({
      success: true,
      users: usersWithStats,
      totalCount: usersWithStats.length,
      activeAdvisorsCount: usersWithStats.filter(u => u.role === 'sales' && u.active).length,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/users - Create new sales advisor or admin
// -------------------------------------------------------------
export const createUser = async (req, res) => {
  try {
    const { name, email, password, role, title, specialty, active } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' })
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email address is required' })
    }

    const normalizedEmail = email.trim().toLowerCase()

    // Check email uniqueness
    const existing = await User.findOne({ email: normalizedEmail })
    if (existing) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists' })
    }

    const assignedRole = role === 'admin' ? 'admin' : 'sales'
    const assignedTitle = title?.trim() || (assignedRole === 'admin' ? 'System Administrator' : 'Admissions Counselor')
    const assignedSpecialty = specialty?.trim() || 'Healthcare Admissions'
    const avatar = generateAvatar(name.trim())

    const newUser = new User({
      name: name.trim(),
      email: normalizedEmail,
      password: password && password.trim() ? password.trim() : 'password123',
      role: assignedRole,
      title: assignedTitle,
      specialty: assignedSpecialty,
      avatar,
      active: active !== false,
    })

    await newUser.save()

    res.status(201).json({
      success: true,
      message: `User ${newUser.name} created successfully as ${assignedRole === 'admin' ? 'Administrator' : 'Sales Advisor'}`,
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        title: newUser.title,
        specialty: newUser.specialty,
        avatar: newUser.avatar,
        active: newUser.active,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PUT /api/users/:id - Update existing user
// -------------------------------------------------------------
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params
    const { name, email, password, role, title, specialty, active } = req.body

    const user = await User.findById(id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    if (name && name.trim()) {
      user.name = name.trim()
      user.avatar = generateAvatar(user.name)
    }

    if (email && email.trim()) {
      const normalizedEmail = email.trim().toLowerCase()
      if (normalizedEmail !== user.email) {
        const existing = await User.findOne({ email: normalizedEmail, _id: { $ne: id } })
        if (existing) {
          return res.status(400).json({ success: false, message: 'Email address already in use by another user' })
        }
        user.email = normalizedEmail
      }
    }

    if (password && password.trim()) {
      user.password = password.trim()
    }

    if (role) {
      user.role = role === 'admin' ? 'admin' : 'sales'
    }

    if (title !== undefined) {
      user.title = title.trim()
    }

    if (specialty !== undefined) {
      user.specialty = specialty.trim()
    }

    if (active !== undefined) {
      user.active = Boolean(active)
    }

    await user.save()

    // If name or specialty updated, update the embedded assignedTo on active leads
    if (name || specialty) {
      await Lead.updateMany(
        {
          $or: [
            { 'assignedTo.repId': user._id },
            { 'assignedTo.repId': user._id.toString() },
          ],
        },
        {
          $set: {
            'assignedTo.repName': user.name,
            'assignedTo.specialty': user.specialty,
          },
        }
      )
    }

    res.status(200).json({
      success: true,
      message: `User ${user.name} updated successfully`,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        title: user.title,
        specialty: user.specialty,
        avatar: user.avatar,
        active: user.active,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// DELETE /api/users/:id - Delete user & optionally reassign leads
// -------------------------------------------------------------
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params
    const { reassignToPool = true } = req.body || {}

    const user = await User.findById(id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    // Safety: prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' })
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete the only system administrator account.',
        })
      }
    }

    // Count how many leads are assigned to this user
    const assignedLeadsQuery = {
      $or: [
        { 'assignedTo.repId': user._id },
        { 'assignedTo.repId': user._id.toString() },
      ],
    }

    const assignedCount = await Lead.countDocuments(assignedLeadsQuery)

    if (reassignToPool && assignedCount > 0) {
      // Return their assigned leads back to the Unassigned Pool
      await Lead.updateMany(assignedLeadsQuery, {
        $set: {
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          subStatus: 'Returned to Pool (Advisor Removed)',
        },
        $push: {
          notes: {
            text: `Advisor ${user.name} was removed from the team. Lead returned to pool for reallocation.`,
            author: 'Admin System',
            status: 'Not Contacted',
            subStatus: 'Returned to Pool',
            timestamp: new Date(),
          },
        },
      })
    }

    await User.findByIdAndDelete(id)

    res.status(200).json({
      success: true,
      message: `User ${user.name} removed successfully.${
        assignedCount > 0 && reassignToPool
          ? ` ${assignedCount} assigned lead(s) returned to unassigned pool.`
          : ''
      }`,
      returnedLeadsCount: reassignToPool ? assignedCount : 0,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
