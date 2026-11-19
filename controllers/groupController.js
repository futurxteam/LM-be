import CounselorGroup from '../models/CounselorGroup.js'
import User from '../models/User.js'
import Lead from '../models/Lead.js'

// -------------------------------------------------------------
// GET /api/groups - List all Counselor Groups with Metrics
// -------------------------------------------------------------
export const getAllGroups = async (req, res) => {
  try {
    const groups = await CounselorGroup.find()
      .populate('managerId', 'name email title specialty avatar active')
      .populate('memberIds', 'name email title specialty avatar active isGroupManager')
      .sort({ createdAt: -1 })

    // Compute live stats for each group
    const enrichedGroups = await Promise.all(
      groups.map(async group => {
        const memberUserIds = (group.memberIds || []).map(m => m._id)

        const totalLeads = await Lead.countDocuments({
          $or: [
            { groupId: group._id },
            { 'assignedTo.repId': { $in: memberUserIds } },
          ],
        })

        const completedCount = await Lead.countDocuments({
          $or: [
            { groupId: group._id },
            { 'assignedTo.repId': { $in: memberUserIds } },
          ],
          isCompleted: true,
        })

        const droppedCount = await Lead.countDocuments({
          $or: [
            { groupId: group._id },
            { 'assignedTo.repId': { $in: memberUserIds } },
          ],
          isDropped: true,
        })

        const activeCount = await Lead.countDocuments({
          $or: [
            { groupId: group._id },
            { 'assignedTo.repId': { $in: memberUserIds } },
          ],
          isCompleted: { $ne: true },
          isDropped: { $ne: true },
        })

        return {
          id: group._id,
          name: group.name,
          description: group.description,
          manager: group.managerId,
          members: group.memberIds,
          active: group.active,
          stats: {
            totalLeads,
            completedCount,
            droppedCount,
            activeCount,
          },
          createdAt: group.createdAt,
        }
      })
    )

    res.status(200).json({ success: true, count: enrichedGroups.length, groups: enrichedGroups })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// -------------------------------------------------------------
// POST /api/groups - Create a new Counselor Group
// -------------------------------------------------------------
export const createGroup = async (req, res) => {
  try {
    const { name, description, managerId, memberIds, active } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required' })
    }

    const existing = await CounselorGroup.findOne({ name: new RegExp(`^${name.trim()}$`, 'i') })
    if (existing) {
      return res.status(400).json({ success: false, message: 'A group with this name already exists' })
    }

    const members = Array.isArray(memberIds) ? memberIds : []
    // Ensure manager is also in memberIds list if selected
    if (managerId && !members.includes(managerId)) {
      members.push(managerId)
    }

    const newGroup = new CounselorGroup({
      name: name.trim(),
      description: description?.trim() || '',
      managerId: managerId || null,
      memberIds: members,
      active: active !== false,
    })

    const saved = await newGroup.save()

    // Sync User models
    if (members.length > 0) {
      await User.updateMany({ _id: { $in: members } }, { $set: { groupId: saved._id } })
    }
    if (managerId) {
      await User.findByIdAndUpdate(managerId, { $set: { isGroupManager: true, groupId: saved._id } })
    }

    res.status(201).json({
      success: true,
      message: `Group "${saved.name}" created successfully`,
      group: saved,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// -------------------------------------------------------------
// PUT /api/groups/:id - Update Counselor Group
// -------------------------------------------------------------
export const updateGroup = async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, managerId, memberIds, active } = req.body

    const group = await CounselorGroup.findById(id)
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' })
    }

    // Previous manager / members
    const oldManagerId = group.managerId ? String(group.managerId) : null
    const oldMemberIds = (group.memberIds || []).map(String)

    if (name && name.trim()) group.name = name.trim()
    if (description !== undefined) group.description = description.trim()
    if (active !== undefined) group.active = Boolean(active)

    const members = Array.isArray(memberIds) ? memberIds : oldMemberIds
    if (managerId && !members.includes(managerId)) {
      members.push(managerId)
    }

    group.managerId = managerId || null
    group.memberIds = members

    const updated = await group.save()

    // Reset previous manager flag if manager changed
    if (oldManagerId && oldManagerId !== String(managerId)) {
      await User.findByIdAndUpdate(oldManagerId, { $set: { isGroupManager: false } })
    }

    // Set new manager flag
    if (managerId) {
      await User.findByIdAndUpdate(managerId, { $set: { isGroupManager: true, groupId: updated._id } })
    }

    // Sync members groupId
    await User.updateMany({ groupId: updated._id, _id: { $nin: members } }, { $set: { groupId: null, isGroupManager: false } })
    await User.updateMany({ _id: { $in: members } }, { $set: { groupId: updated._id } })

    res.status(200).json({
      success: true,
      message: `Group "${updated.name}" updated successfully`,
      group: updated,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// -------------------------------------------------------------
// DELETE /api/groups/:id - Delete Counselor Group
// -------------------------------------------------------------
export const deleteGroup = async (req, res) => {
  try {
    const { id } = req.params
    const group = await CounselorGroup.findById(id)
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' })
    }

    // Clear groupId and isGroupManager on member users
    await User.updateMany({ groupId: id }, { $set: { groupId: null, isGroupManager: false } })

    await CounselorGroup.findByIdAndDelete(id)

    res.status(200).json({
      success: true,
      message: `Group "${group.name}" deleted successfully`,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}
