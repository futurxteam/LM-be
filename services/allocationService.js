import MetaIntegration from '../models/MetaIntegration.js'
import User from '../models/User.js'
import Lead from '../models/Lead.js'
import CounselorGroup from '../models/CounselorGroup.js'

/**
 * Capacity-Aware Round-Robin Lead Allocation Engine
 * - If form has assigned group, rotates among group members.
 * - If form has specific counselors, rotates among them.
 * - Default: Rotates among all active admissions counselors.
 * - Rule: Counselors who clear their leads (isDropped=true or isCompleted=true)
 *   have lower active load, earning priority in the rotation!
 */
export async function allocateLead(formId) {
  try {
    const config = await MetaIntegration.findOne()
    const form = config?.selectedForms?.find(f => f.formId === String(formId))

    let candidates = []
    let assignedGroupId = form?.assignedGroupId || null

    // 1. Check if assigned to a specific Group
    if (assignedGroupId) {
      const group = await CounselorGroup.findById(assignedGroupId)
      if (group && group.memberIds && group.memberIds.length > 0) {
        candidates = await User.find({
          _id: { $in: group.memberIds },
          active: true,
          role: 'sales',
        })
      }
    }

    // 2. Check if assigned to specific Counselors
    if (candidates.length === 0 && form?.assignedCounselorIds && form.assignedCounselorIds.length > 0) {
      candidates = await User.find({
        _id: { $in: form.assignedCounselorIds },
        active: true,
        role: 'sales',
      })
    }

    // 3. Default: Fallback to all active Admissions Counselors
    if (candidates.length === 0) {
      candidates = await User.find({ role: 'sales', active: true })
    }

    // If still no counselors exist in the system, keep in system pool
    if (candidates.length === 0) {
      return {
        assignmentStatus: 'UNASSIGNED',
        assignedTo: null,
        groupId: null,
      }
    }

    // 4. Single Counselor assigned -> 100% of leads to this counselor
    if (candidates.length === 1) {
      const single = candidates[0]
      return {
        assignmentStatus: 'ASSIGNED',
        assignedTo: {
          repId: single._id,
          repName: single.name,
          repRole: single.title || 'Admissions Counselor',
          assignedAt: new Date(),
        },
        groupId: single.groupId || assignedGroupId || null,
      }
    }

    // 5. Multiple Counselors -> Capacity-Aware Round-Robin
    // Measure active load for each counselor (leads NOT dropped and NOT completed)
    const counselorStats = await Promise.all(
      candidates.map(async counselor => {
        const activeCount = await Lead.countDocuments({
          $or: [
            { 'assignedTo.repId': counselor._id },
            { 'assignedTo.repId': String(counselor._id) },
          ],
          isDropped: { $ne: true },
          isCompleted: { $ne: true },
        })

        const resolvedCount = await Lead.countDocuments({
          $or: [
            { 'assignedTo.repId': counselor._id },
            { 'assignedTo.repId': String(counselor._id) },
          ],
          $or: [{ isDropped: true }, { isCompleted: true }],
        })

        return {
          counselor,
          activeCount,
          resolvedCount,
        }
      })
    )

    // Sort by:
    // 1. activeCount ASCENDING (counselor with lowest active backlog has the most pool space!)
    // 2. resolvedCount DESCENDING (reward counselors who have dropped/completed more leads)
    counselorStats.sort((a, b) => {
      if (a.activeCount !== b.activeCount) {
        return a.activeCount - b.activeCount
      }
      return b.resolvedCount - a.resolvedCount
    })

    const chosen = counselorStats[0].counselor

    // Advance round-robin pointer on the form
    if (form && config) {
      form.roundRobinIndex = ((form.roundRobinIndex || 0) + 1) % candidates.length
      await config.save()
    }

    return {
      assignmentStatus: 'ASSIGNED',
      assignedTo: {
        repId: chosen._id,
        repName: chosen.name,
        repRole: chosen.title || 'Admissions Counselor',
        assignedAt: new Date(),
      },
      groupId: chosen.groupId || assignedGroupId || null,
    }
  } catch (err) {
    console.error('Error in lead allocation engine:', err)
    return {
      assignmentStatus: 'UNASSIGNED',
      assignedTo: null,
      groupId: null,
    }
  }
}
