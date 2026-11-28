import mongoose from 'mongoose'
import DiscountApproval from '../models/DiscountApproval.js'
import Lead from '../models/Lead.js'
import { getOrCreateCrmSettings } from '../models/CrmSettings.js'
import { applyLifecycleUpdate, syncReferralForLead } from './leadController.js'
import { notifyTelegramEvent, formatMoneyIN } from '../services/telegramService.js'

// -------------------------------------------------------------
// GET /api/discounts/approvals (Admin Only, Paginated by 30)
// -------------------------------------------------------------
export const getDiscountApprovals = async (req, res) => {
  try {
    const { status = 'PENDING', search = '', page = 1, limit = 30 } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))
    const skip = (pageNum - 1) * limitNum

    const filter = {}
    if (status && status !== 'ALL') {
      filter.status = status
    }
    if (search && String(search).trim()) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(escaped, 'i')
      filter.$or = [
        { leadName: regex },
        { leadPhone: regex },
        { programName: regex },
        { discountReason: regex },
        { discountReasonDescription: regex },
        { 'requestedBy.name': regex },
      ]
    }

    const [total, pendingCount, approvedCount, rejectedCount, requests] = await Promise.all([
      DiscountApproval.countDocuments(filter),
      DiscountApproval.countDocuments({ status: 'PENDING' }),
      DiscountApproval.countDocuments({ status: 'APPROVED' }),
      DiscountApproval.countDocuments({ status: 'REJECTED' }),
      DiscountApproval.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ])

    res.status(200).json({
      success: true,
      requests: requests.map(r => ({
        ...r,
        id: r._id.toString(),
        leadId: r.leadId ? r.leadId.toString() : null,
      })),
      counts: {
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/discounts/approvals/pending-count (Admin Only)
// -------------------------------------------------------------
export const getPendingDiscountCount = async (req, res) => {
  try {
    const pendingCount = await DiscountApproval.countDocuments({ status: 'PENDING' })
    res.status(200).json({ success: true, pendingCount })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/discounts/approvals/:id/approve (Admin Only)
// Admin can optionally adjust finalAgreedAmount before approving.
// Unlocks the lead and applies the pending status change + receipt + discount.
// -------------------------------------------------------------
export const approveDiscountRequest = async (req, res) => {
  try {
    const { id } = req.params
    const { finalAgreedAmount, adminRemarks = '' } = req.body || {}

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid approval request ID' })
    }

    const reqDoc = await DiscountApproval.findById(id)
    if (!reqDoc) {
      return res.status(404).json({ success: false, message: 'Discount approval request not found' })
    }
    if (reqDoc.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `This request has already been ${reqDoc.status.toLowerCase()}.`,
      })
    }

    const lead = await Lead.findById(reqDoc.leadId)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Associated lead not found' })
    }

    const stdFee = Number(reqDoc.standardCourseFee) || Number(lead.courseFees) || 0
    const approvedAgreed =
      finalAgreedAmount !== undefined && finalAgreedAmount !== '' && finalAgreedAmount !== null
        ? Number(finalAgreedAmount)
        : Number(reqDoc.requestedAgreedAmount)

    if (Number.isNaN(approvedAgreed) || approvedAgreed < 0) {
      return res.status(400).json({ success: false, message: 'Approved agreed amount cannot be negative.' })
    }
    if (stdFee > 0 && approvedAgreed > stdFee) {
      return res.status(400).json({
        success: false,
        message: `Approved agreed amount (₹${approvedAgreed.toLocaleString('en-IN')}) cannot exceed standard course fee (₹${stdFee.toLocaleString('en-IN')}).`,
      })
    }

    const finalDiscount = stdFee > 0 ? Math.max(0, stdFee - approvedAgreed) : 0

    // Execute the stored lifecycle update payload as Admin (with approved agreed amount)
    const settings = await getOrCreateCrmSettings()
    const mergedPayload = {
      ...(reqDoc.pendingPayload || {}),
      categoryKey: reqDoc.categoryKey || reqDoc.pendingPayload?.categoryKey,
      courseFees: stdFee,
      agreedAmount: approvedAgreed,
      discountReason: reqDoc.discountReason,
      discountReasonDescription: reqDoc.discountReasonDescription || '',
      note:
        (reqDoc.pendingPayload?.note ? `${reqDoc.pendingPayload.note} | ` : '') +
        `Discount approved by ${req.user?.name || 'Admin'} (Agreed: ₹${approvedAgreed.toLocaleString('en-IN')}, Discount: ₹${finalDiscount.toLocaleString('en-IN')}, Reason: ${reqDoc.discountReason}${reqDoc.discountReasonDescription ? ` — ${reqDoc.discountReasonDescription}` : ''})${adminRemarks.trim() ? ` | Admin Note: ${adminRemarks.trim()}` : ''}`,
    }

    const result = await applyLifecycleUpdate(lead, mergedPayload, req.user, settings)
    if (result.error) {
      return res.status(result.statusCode || 400).json({ success: false, message: result.error })
    }

    // Preserve original requester attribution on discountSetBy while recording approval
    lead.discountApprovalStatus = 'APPROVED'
    lead.pendingDiscountRequestId = null
    lead.discountReason = reqDoc.discountReason
    lead.discountReasonDescription = reqDoc.discountReasonDescription || ''
    if (finalDiscount > 0) {
      lead.discountSetBy = {
        userId: reqDoc.requestedBy?.userId || req.user?.id || '',
        name: reqDoc.requestedBy?.name || req.user?.name || 'Staff',
        role: reqDoc.requestedBy?.role || 'sales',
        setAt: new Date(),
      }
    }
    await lead.save()
    await syncReferralForLead(lead)

    reqDoc.status = 'APPROVED'
    reqDoc.finalAgreedAmount = approvedAgreed
    reqDoc.finalDiscountAmount = finalDiscount
    reqDoc.decidedBy = {
      userId: req.user?.id || req.user?._id || '',
      name: req.user?.name || 'Administrator',
    }
    reqDoc.decidedAt = new Date()
    reqDoc.adminRemarks = String(adminRemarks || '').trim()
    reqDoc.repNotificationRead = false
    await reqDoc.save()

    // Notify requesting counselor via Telegram (non-blocking)
    notifyTelegramEvent(
      'discountApproved',
      {
        leadName: lead.fullName || reqDoc.leadName,
        phone: lead.phone || reqDoc.leadPhone || 'N/A',
        targetStatus: lead.leadStatus || reqDoc.targetStatus || '',
        agreedAmount: formatMoneyIN(approvedAgreed),
        discountAmount: formatMoneyIN(finalDiscount),
        decidedBy: req.user?.name || 'Administrator',
        remarks: String(adminRemarks || '').trim() || 'None',
      },
      {
        targetUserIds: [reqDoc.requestedBy?.userId, lead.assignedTo?.repId].filter(Boolean),
      }
    )

    res.status(200).json({
      success: true,
      message: `Discount approved! Lead "${lead.fullName}" updated to ${lead.leadStatus}.`,
      request: { ...reqDoc.toObject(), id: reqDoc._id.toString() },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/discounts/approvals/:id/reject (Admin Only)
// Unlocks the lead at its previous status (no discount applied, not in Discount Report)
// -------------------------------------------------------------
export const rejectDiscountRequest = async (req, res) => {
  try {
    const { id } = req.params
    const { adminRemarks = '' } = req.body || {}

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid approval request ID' })
    }

    const reqDoc = await DiscountApproval.findById(id)
    if (!reqDoc) {
      return res.status(404).json({ success: false, message: 'Discount approval request not found' })
    }
    if (reqDoc.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `This request has already been ${reqDoc.status.toLowerCase()}.`,
      })
    }

    const lead = await Lead.findById(reqDoc.leadId)
    if (lead) {
      lead.discountApprovalStatus = 'REJECTED'
      lead.pendingDiscountRequestId = null
      lead.notes = lead.notes || []
      lead.notes.unshift({
        text: `Discount request (Agreed ₹${Number(reqDoc.requestedAgreedAmount).toLocaleString('en-IN')} / Discount ₹${Number(reqDoc.requestedDiscountAmount).toLocaleString('en-IN')}) REJECTED by ${req.user?.name || 'Admin'}.${adminRemarks.trim() ? ` Reason: ${adminRemarks.trim()}` : ''}`,
        author: req.user?.name || 'Administrator',
        status: lead.status,
        subStatus: lead.subStatus,
        timestamp: new Date(),
      })
      await lead.save()
    }

    reqDoc.status = 'REJECTED'
    reqDoc.decidedBy = {
      userId: req.user?.id || req.user?._id || '',
      name: req.user?.name || 'Administrator',
    }
    reqDoc.decidedAt = new Date()
    reqDoc.adminRemarks = String(adminRemarks || '').trim()
    reqDoc.repNotificationRead = false
    await reqDoc.save()

    // Notify requesting counselor via Telegram (non-blocking)
    notifyTelegramEvent(
      'discountRejected',
      {
        leadName: reqDoc.leadName || lead?.fullName || 'Lead',
        phone: reqDoc.leadPhone || lead?.phone || 'N/A',
        agreedAmount: formatMoneyIN(reqDoc.requestedAgreedAmount),
        decidedBy: req.user?.name || 'Administrator',
        remarks: String(adminRemarks || '').trim() || 'None',
      },
      {
        targetUserIds: [reqDoc.requestedBy?.userId, lead?.assignedTo?.repId].filter(Boolean),
      }
    )

    res.status(200).json({
      success: true,
      message: `Discount request rejected. Lead "${reqDoc.leadName}" unlocked at previous status.`,
      request: { ...reqDoc.toObject(), id: reqDoc._id.toString() },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/discounts/my-notifications (Sales Rep / Manager Home Screen)
// Returns unread Approved/Rejected decisions + current Pending requests for caller
// -------------------------------------------------------------
export const getMyDiscountNotifications = async (req, res) => {
  try {
    const callerId = String(req.user?.id || req.user?._id || '')
    if (!callerId) {
      return res.status(200).json({ success: true, notifications: [], pendingCount: 0 })
    }

    const [unreadDecisions, pendingCount] = await Promise.all([
      DiscountApproval.find({
        'requestedBy.userId': callerId,
        status: { $in: ['APPROVED', 'REJECTED'] },
        repNotificationRead: false,
      })
        .sort({ decidedAt: -1 })
        .limit(15)
        .lean(),
      DiscountApproval.countDocuments({
        'requestedBy.userId': callerId,
        status: 'PENDING',
      }),
    ])

    res.status(200).json({
      success: true,
      pendingCount,
      notifications: unreadDecisions.map(n => ({
        ...n,
        id: n._id.toString(),
        leadId: n.leadId ? n.leadId.toString() : null,
      })),
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PATCH /api/discounts/my-notifications/:id/read
// -------------------------------------------------------------
export const markDiscountNotificationRead = async (req, res) => {
  try {
    const { id } = req.params
    const callerId = String(req.user?.id || req.user?._id || '')
    await DiscountApproval.findOneAndUpdate(
      { _id: id, 'requestedBy.userId': callerId },
      { $set: { repNotificationRead: true } }
    )
    res.status(200).json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

