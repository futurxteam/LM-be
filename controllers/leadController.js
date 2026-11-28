import mongoose from 'mongoose'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import MetaIntegration from '../models/MetaIntegration.js'
import CourseProgram, { ensureDefaultPrograms } from '../models/CourseProgram.js'
import Referral from '../models/Referral.js'
import Student from '../models/Student.js'
import CounselorGroup from '../models/CounselorGroup.js'
import DiscountApproval, { DISCOUNT_REASONS } from '../models/DiscountApproval.js'
import {
  getOrCreateCrmSettings,
  LEAD_STATUSES,
  BUSINESS_STATUSES,
  INQUIRY_INTENT_STATUSES,
  deriveHeatTierFromStatus,
} from '../models/CrmSettings.js'
import { isLeadAssignedToUser } from '../middleware/authMiddleware.js'
import { parseLeadsData, sanitizePhone } from '../utils/leadParser.js'
import { allocateLead } from '../services/allocationService.js'
import { isCounselorPaused } from '../utils/counselorUtils.js'
import { notifyTelegramEvent, formatMoneyIN } from '../services/telegramService.js'

/**
 * Escape special regex characters so phone numbers with '+' or symbols never crash RegExp
 */
function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build unified MongoDB search filter matching Name, Lead ID (_id / metaLeadId, with or without '#'),
 * Phone Number, Email, Qualification, Location, Campaign, Category, and Program.
 */
function buildLeadSearchCondition(rawSearch) {
  const trimmed = String(rawSearch || '').trim()
  if (!trimmed) return null
  const cleanIdTerm = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed
  const regex = new RegExp(escapeRegex(trimmed), 'i')
  const idRegex = cleanIdTerm ? new RegExp(escapeRegex(cleanIdTerm), 'i') : regex

  const orConditions = [
    { fullName: regex },
    { phone: regex },
    { email: regex },
    { metaLeadId: idRegex },
    { courseProgram: regex },
    { courseVariant: regex },
    { qualification: regex },
    { preferredLocation: regex },
    { campaignName: regex },
    { selectedCategoryLabel: regex },
    { businessProgramName: regex },
  ]

  if (cleanIdTerm) {
    if (mongoose.Types.ObjectId.isValid(cleanIdTerm)) {
      orConditions.push({ _id: new mongoose.Types.ObjectId(cleanIdTerm) })
    }
    orConditions.push({
      $expr: {
        $regexMatch: {
          input: { $toString: '$_id' },
          regex: escapeRegex(cleanIdTerm),
          options: 'i',
        },
      },
    })
  }

  return { $or: orConditions }
}

/**
 * Strip Admin-only heatTier classification for non-admin callers
 */
function sanitizeLeadForRole(leadDoc, role) {
  const obj = typeof leadDoc.toObject === 'function' ? leadDoc.toObject() : { ...leadDoc }
  obj.id = obj._id ? obj._id.toString() : obj.id
  obj.leadStatus = obj.leadStatus || 'NEW LEAD'
  if (role !== 'admin') {
    delete obj.heatTier
    delete obj.lostCycleCount
    delete obj.canRecycle
    delete obj.cycleEndReason
    if (Array.isArray(obj.steps)) {
      obj.steps = obj.steps.map(s => {
        const copy = { ...s }
        delete copy.heatTier
        delete copy.cycleNumber
        return copy
      })
    }
  }
  return obj
}

/**
 * Count meaningful interactions logged in the lead's current cycle
 * (excludes system/admin recycle entries)
 */
function countCurrentCycleInteractions(lead) {
  const currentCycle = lead.cycleNumber || 1
  const steps = Array.isArray(lead.steps) ? lead.steps : []
  const cycleSteps = steps.filter(
    s =>
      (s.cycleNumber || 1) === currentCycle &&
      s.selectedCategory !== 'admin_recycled' &&
      s.selectedCategory !== 'auto_recycled'
  )
  if (cycleSteps.length > 0) return cycleSteps.length
  // Legacy fallback: only applies to cycle #1 leads created before steps[] existed
  if (currentCycle === 1 && (lead.callAttempts || 0) > 0) return lead.callAttempts
  return 0
}

/**
 * Capacity-aware Round-Robin counselor picker for Lost Recycling
 * Prefers active counselors other than excludeRepId when available
 */
async function pickRoundRobinCounselor(excludeRepId = null) {
  const allActiveReps = (
    await User.find({
      role: { $in: ['sales', 'manager'] },
      active: { $ne: false },
      receiveLeads: { $ne: false },
    }).lean()
  ).filter(r => !isCounselorPaused(r))
  if (allActiveReps.length === 0) return null

  const filtered = excludeRepId
    ? allActiveReps.filter(r => String(r._id) !== String(excludeRepId))
    : allActiveReps
  const pool = filtered.length > 0 ? filtered : allActiveReps

  const stats = await Promise.all(
    pool.map(async rep => {
      const activeCount = await Lead.countDocuments({
        $or: [
          { 'assignedTo.repId': rep._id },
          { 'assignedTo.repId': String(rep._id) },
        ],
        leadStatus: { $ne: 'LOST' },
        isDropped: { $ne: true },
        isCompleted: { $ne: true },
        isCycleEnded: { $ne: true },
      })
      return { rep, activeCount }
    })
  )

  stats.sort((a, b) => a.activeCount - b.activeCount)
  return stats[0]?.rep || null
}

/**
 * Core lifecycle transition & step logger shared across status/step/profile updates
 */
export async function applyLifecycleUpdate(lead, payload, actor, settings) {
  const isAdmin = actor?.role === 'admin'
  const prevStatus = lead.leadStatus || 'NEW LEAD'

  const {
    categoryKey,
    leadStatus: requestedStatus,
    status: legacyStatus,
    subStatus: legacySubStatus,
    note,
    callbackAt,
    incrementCallAttempt,
    lostReason,
    inquiryIntent,
    newReceipt,
    businessProgramId,
    businessProgramName,
    businessProgramVariant,
    courseFees,
    agreedAmount,
    paidAmount,
    adminException,
    author,
    isCompleted,
    isDropped,
    droppedReason,
  } = payload

  // Resolve outcome category & target status
  let matchedCategory = null
  if (categoryKey) {
    matchedCategory = (settings.outcomeCategories || []).find(
      c => c.key === String(categoryKey).trim() && c.active !== false
    )
    if (!matchedCategory) {
      return { error: `Unknown or inactive outcome category: "${categoryKey}"`, statusCode: 400 }
    }
  }

  let nextStatus = prevStatus
  if (matchedCategory) {
    nextStatus = matchedCategory.leadStatus
  } else if (requestedStatus && LEAD_STATUSES.includes(requestedStatus)) {
    nextStatus = requestedStatus
  }

  // Irreversible terminal-status guard for Sales Reps
  // LOST, CONVERTED BUSINESS, ONBOARDED BUSINESS, and NON PROSPECT cannot be reversed by Sales Reps
  // (Only staying on CONVERTED BUSINESS for installments/notes or advancing CONVERTED -> ONBOARDED is allowed for Sales)
  const irreversibleForSales = ['LOST', 'NON PROSPECT', 'CONVERTED BUSINESS', 'ONBOARDED BUSINESS']
  if (!isAdmin && (lead.isCycleEnded || irreversibleForSales.includes(prevStatus))) {
    const isAllowedOnboardingProgress =
      prevStatus === 'CONVERTED BUSINESS' &&
      (nextStatus === 'ONBOARDED BUSINESS' || nextStatus === 'CONVERTED BUSINESS')
    if (!isAllowedOnboardingProgress) {
      return {
        error: 'This lead status cannot be reversed by a Sales Counselor. Contact an Administrator if changes are needed.',
        statusCode: 403,
      }
    }
  }

  // 1st-Interaction Unlock Gate: LOST, CONVERTED BUSINESS, and ONBOARDED BUSINESS unlock only after 1st interaction
  const requiresFirstInteraction = ['LOST', 'CONVERTED BUSINESS', 'ONBOARDED BUSINESS']
  if (!isAdmin && requiresFirstInteraction.includes(nextStatus) && countCurrentCycleInteractions(lead) === 0) {
    return {
      error: `${nextStatus} is locked until after the 1st interaction is logged for this lead.`,
      statusCode: 400,
    }
  }

  // Derive heatTier (server-side, Admin-only in responses)
  const nextHeatTier = matchedCategory
    ? matchedCategory.heatTier || deriveHeatTierFromStatus(nextStatus)
    : deriveHeatTierFromStatus(nextStatus)

  // Validate mandatory Lost Reason when transitioning to LOST
  const cleanLostReason = String(lostReason ?? droppedReason ?? '').trim()
  if (nextStatus === 'LOST' && !cleanLostReason && !lead.lostReason) {
    return {
      error: 'Lost Reason is mandatory when marking a lead as LOST.',
      statusCode: 400,
    }
  }

  // Check conditional Business / Financial fields for QUALIFIED / CONVERTED / ONBOARDED BUSINESS
  const isBusinessStatus = BUSINESS_STATUSES.includes(nextStatus)
  const hasFinancialPayload =
    businessProgramId !== undefined ||
    businessProgramName !== undefined ||
    businessProgramVariant !== undefined ||
    courseFees !== undefined ||
    agreedAmount !== undefined ||
    paidAmount !== undefined

  const prevFinancial = {
    businessProgramName: lead.businessProgramName || '',
    businessProgramVariant: lead.businessProgramVariant || '',
    courseFees: lead.courseFees ?? null,
    agreedAmount: lead.agreedAmount ?? null,
    discountAmount: lead.discountAmount ?? 0,
    paidAmount: lead.paidAmount ?? null,
  }

  // Permission check for editing already-saved financial values
  const alreadyHasFinancial =
    Boolean(lead.businessProgramName) || lead.courseFees !== null || lead.paidAmount !== null
  if (hasFinancialPayload && alreadyHasFinancial && !isAdmin && !settings.allowSalesFinancialEdit) {
    const changingExisting =
      (businessProgramName !== undefined && businessProgramName !== lead.businessProgramName) ||
      (courseFees !== undefined && Number(courseFees) !== Number(lead.courseFees)) ||
      (paidAmount !== undefined && Number(paidAmount) !== Number(lead.paidAmount))
    if (changingExisting) {
      return {
        error: 'Financial fields are locked after entry. Contact an Administrator to edit them.',
        statusCode: 403,
      }
    }
  }

  let resolvedProgram = null
  if (businessProgramId || businessProgramName) {
    await ensureDefaultPrograms()
    if (businessProgramId && mongoose.Types.ObjectId.isValid(businessProgramId)) {
      resolvedProgram = await CourseProgram.findById(businessProgramId)
    } else if (businessProgramName) {
      resolvedProgram = await CourseProgram.findOne({
        name: new RegExp(`^${String(businessProgramName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      })
    }
  }

  const nextProgramId = resolvedProgram ? resolvedProgram._id : lead.businessProgramId
  const nextProgramName = resolvedProgram
    ? resolvedProgram.name
    : businessProgramName !== undefined
    ? String(businessProgramName).trim()
    : lead.businessProgramName

  let nextProgramVariant =
    businessProgramVariant !== undefined
      ? String(businessProgramVariant).trim()
      : lead.businessProgramVariant || ''
  // Clear variant if program changed to one that does not support that variant
  if (resolvedProgram && Array.isArray(resolvedProgram.variants)) {
    if (resolvedProgram.variants.length === 0) {
      nextProgramVariant = ''
    } else if (nextProgramVariant && !resolvedProgram.variants.includes(nextProgramVariant)) {
      nextProgramVariant = ''
    }
  }

  // Validate FRD Section 9: disallow negative Course Fees, Agreed Amount, Paid Amount, or Receipt Amount
  if (courseFees !== undefined && courseFees !== '' && courseFees !== null && Number(courseFees) < 0) {
    return { error: 'Course Fees cannot be negative.', statusCode: 400 }
  }
  if (agreedAmount !== undefined && agreedAmount !== '' && agreedAmount !== null && Number(agreedAmount) < 0) {
    return { error: 'Total Agreed Amount cannot be negative.', statusCode: 400 }
  }
  if (paidAmount !== undefined && paidAmount !== '' && paidAmount !== null && Number(paidAmount) < 0) {
    return { error: 'Paid Amount cannot be negative.', statusCode: 400 }
  }
  if (newReceipt && newReceipt.amount !== undefined && newReceipt.amount !== '' && Number(newReceipt.amount) > 0 && Number(newReceipt.amount) < 0) {
    return { error: 'Receipt amount cannot be negative.', statusCode: 400 }
  }

  const nextCourseFees =
    courseFees !== undefined && courseFees !== '' && courseFees !== null
      ? Number(courseFees)
      : lead.courseFees

  const nextAgreedAmount =
    agreedAmount !== undefined && agreedAmount !== '' && agreedAmount !== null
      ? Number(agreedAmount)
      : lead.agreedAmount !== null && lead.agreedAmount !== undefined
      ? lead.agreedAmount
      : nextCourseFees

  if (
    nextCourseFees !== null &&
    nextCourseFees !== undefined &&
    nextAgreedAmount !== null &&
    nextAgreedAmount !== undefined &&
    nextAgreedAmount > nextCourseFees
  ) {
    return {
      error: `Total Agreed Amount (₹${nextAgreedAmount.toLocaleString('en-IN')}) cannot exceed Course Fees (₹${nextCourseFees.toLocaleString('en-IN')}).`,
      statusCode: 400,
    }
  }

  const existingReceipts = Array.isArray(lead.paymentReceipts) ? lead.paymentReceipts : []
  const existingReceiptSum = existingReceipts.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const receiptAmountNum =
    newReceipt && newReceipt.amount !== undefined && newReceipt.amount !== '' && Number(newReceipt.amount) > 0
      ? Number(newReceipt.amount)
      : 0

  let nextPaidAmount =
    paidAmount !== undefined && paidAmount !== '' && paidAmount !== null
      ? Number(paidAmount)
      : lead.paidAmount
  if (receiptAmountNum > 0) {
    const basePaid = existingReceipts.length > 0 ? existingReceiptSum : (Number(lead.paidAmount) || 0)
    nextPaidAmount = basePaid + receiptAmountNum
  }

  if (isBusinessStatus) {
    const bypassAllowed =
      Boolean(adminException) && isAdmin && settings.allowAdminBusinessFieldException !== false
    const mustRequire = settings.requireBusinessFields !== false && !bypassAllowed

    if (mustRequire) {
      if (!nextProgramId || !nextProgramName) {
        return {
          error: 'Course Program (from approved Program Master) is mandatory for Business statuses.',
          statusCode: 400,
        }
      }
      if (nextCourseFees === null || nextCourseFees === undefined || Number.isNaN(nextCourseFees) || nextCourseFees <= 0) {
        return {
          error: 'Course Fees (applicable total course fee > 0) is mandatory for Business statuses.',
          statusCode: 400,
        }
      }
      if (nextPaidAmount === null || nextPaidAmount === undefined || Number.isNaN(nextPaidAmount) || nextPaidAmount < 0) {
        return {
          error: 'Paid Amount (total received >= 0) is mandatory for Business statuses.',
          statusCode: 400,
        }
      }
    }

    // Business Amount & Progression Thresholds:
    // 1. CONVERTED BUSINESS strictly requires total collected fee >= ₹10,000
    if (nextStatus === 'CONVERTED BUSINESS' && !bypassAllowed) {
      if (nextPaidAmount === null || nextPaidAmount === undefined || Number(nextPaidAmount) < 10000) {
        return {
          error: "Can't update step: Total amount is not ₹10,000 or above for Converted Business. For token or advance payments below ₹10,000, please select Qualified.",
          statusCode: 400,
        }
      }
    }

    // 2. QUALIFIED BUSINESS is strictly for advance/token payments below ₹10,000
    if (nextStatus === 'QUALIFIED BUSINESS' && !bypassAllowed) {
      if (nextPaidAmount !== null && nextPaidAmount !== undefined && Number(nextPaidAmount) >= 10000) {
        return {
          error: "Can't update step: Total amount is ₹10,000 or above. Qualified Business is strictly for token/advance payments below ₹10,000. Please select Converted Business.",
          statusCode: 400,
        }
      }
    }

    // 3. ONBOARDED BUSINESS can ONLY be reached from CONVERTED BUSINESS
    if (nextStatus === 'ONBOARDED BUSINESS' && !bypassAllowed) {
      const isCurrentlyConverted =
        prevStatus === 'CONVERTED BUSINESS' || Boolean(lead.milestoneHistory?.convertedAt)
      if (!isCurrentlyConverted) {
        return {
          error: "Can't update step: A lead must first be in Converted Business state (with at least ₹10,000 paid) before it can be Onboarded.",
          statusCode: 400,
        }
      }
      if (nextPaidAmount === null || nextPaidAmount === undefined || Number(nextPaidAmount) < 10000) {
        return {
          error: "Can't update step: Onboarded Business requires at least ₹10,000 collected.",
          statusCode: 400,
        }
      }
    }
  }

  const actorInfo = {
    userId: actor?.id || actor?._id || '',
    name: actor?.name || author || lead.assignedTo?.repName || 'Staff',
    role: actor?.role || 'sales',
  }

  // Apply financial values (NEVER clear previously stored financial values when moving backwards)
  if (resolvedProgram) {
    lead.businessProgramId = resolvedProgram._id
    lead.businessProgramName = resolvedProgram.name
    lead.businessProgramVariant = nextProgramVariant
  } else if (businessProgramVariant !== undefined && lead.businessProgramName) {
    lead.businessProgramVariant = nextProgramVariant
  }
  if (courseFees !== undefined && courseFees !== '' && courseFees !== null && !Number.isNaN(Number(courseFees))) {
    lead.courseFees = Number(courseFees)
  }
  if (agreedAmount !== undefined && agreedAmount !== '' && agreedAmount !== null && !Number.isNaN(Number(agreedAmount))) {
    const newAgreed = Number(agreedAmount)
    const prevAgreed = lead.agreedAmount
    lead.agreedAmount = newAgreed
    const effectiveCourseFee = Number(lead.courseFees) || 0
    const computedDiscount = effectiveCourseFee > 0 ? Math.max(0, effectiveCourseFee - newAgreed) : 0
    const prevDiscount = Number(lead.discountAmount) || 0
    lead.discountAmount = computedDiscount
    // Record who set/modified the discount whenever a discount is applied or updated
    if (computedDiscount > 0 && (prevDiscount !== computedDiscount || prevAgreed !== newAgreed || !lead.discountSetBy?.name)) {
      lead.discountSetBy = {
        userId: actorInfo.userId,
        name: actorInfo.name,
        role: actorInfo.role,
        setAt: new Date(),
      }
    } else if (computedDiscount === 0 && prevDiscount > 0) {
      lead.discountSetBy = { userId: '', name: '', role: '', setAt: null }
    }
  } else if (lead.courseFees !== null && lead.courseFees !== undefined && (lead.agreedAmount === null || lead.agreedAmount === undefined)) {
    lead.agreedAmount = Number(lead.courseFees)
    lead.discountAmount = 0
  } else if (lead.courseFees !== null && lead.courseFees !== undefined && lead.agreedAmount !== null && lead.agreedAmount !== undefined) {
    // Recompute discount if courseFees changed while agreedAmount was already set
    const computedDiscount = Math.max(0, Number(lead.courseFees) - Number(lead.agreedAmount))
    lead.discountAmount = computedDiscount
    if (computedDiscount > 0 && !lead.discountSetBy?.name) {
      lead.discountSetBy = {
        userId: actorInfo.userId,
        name: actorInfo.name,
        role: actorInfo.role,
        setAt: new Date(),
      }
    }
  }

  // Transaction-level Payment Receipts (FRD Section 8 & 9)
  lead.paymentReceipts = lead.paymentReceipts || []
  if (receiptAmountNum > 0) {
    // If legacy lead had paidAmount without receipts, preserve it as Opening Receipt first
    if (lead.paymentReceipts.length === 0 && (Number(lead.paidAmount) || 0) > 0) {
      lead.paymentReceipts.push({
        amount: Number(lead.paidAmount),
        receiptDate: lead.updatedAt || new Date(),
        paymentMode: 'Other',
        referenceNo: 'PREV-RECORDED',
        note: 'Previously recorded amount before itemized receipts',
        recordedBy: { userId: 'system', name: 'System Migration', role: 'system' },
        createdAt: lead.updatedAt || new Date(),
      })
    }
    lead.paymentReceipts.push({
      amount: receiptAmountNum,
      receiptDate: newReceipt.receiptDate ? new Date(newReceipt.receiptDate) : new Date(),
      paymentMode: newReceipt.paymentMode || 'UPI',
      referenceNo: String(newReceipt.referenceNo || '').trim(),
      note: String(newReceipt.note || '').trim(),
      recordedBy: actorInfo,
      createdAt: new Date(),
    })
    lead.paidAmount = lead.paymentReceipts.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  } else if (paidAmount !== undefined && paidAmount !== '' && paidAmount !== null && !Number.isNaN(Number(paidAmount))) {
    const incomingPaid = Number(paidAmount)
    if (lead.paymentReceipts.length === 0 && incomingPaid > 0) {
      lead.paymentReceipts.push({
        amount: incomingPaid,
        receiptDate: new Date(),
        paymentMode: newReceipt?.paymentMode || 'UPI',
        referenceNo: String(newReceipt?.referenceNo || '').trim(),
        note: String(newReceipt?.note || 'Initial payment recorded').trim(),
        recordedBy: actorInfo,
        createdAt: new Date(),
      })
    } else if (lead.paymentReceipts.length > 0 && incomingPaid > existingReceiptSum) {
      lead.paymentReceipts.push({
        amount: incomingPaid - existingReceiptSum,
        receiptDate: new Date(),
        paymentMode: newReceipt?.paymentMode || 'UPI',
        referenceNo: String(newReceipt?.referenceNo || '').trim(),
        note: String(newReceipt?.note || 'Additional payment recorded').trim(),
        recordedBy: actorInfo,
        createdAt: new Date(),
      })
    }
    lead.paidAmount = incomingPaid
  }

  // Flag Paid Amount exceeding Agreed Amount (or Course Fees) for Admin review (FRD Section 9)
  const effectiveTargetFee =
    lead.agreedAmount !== null && lead.agreedAmount !== undefined && lead.agreedAmount > 0
      ? Number(lead.agreedAmount)
      : Number(lead.courseFees) || 0
  lead.overpaidFlag = Boolean(
    effectiveTargetFee > 0 && (Number(lead.paidAmount) || 0) > effectiveTargetFee
  )

  // Audit financial changes if any value changed
  const newFinancial = {
    businessProgramName: lead.businessProgramName || '',
    businessProgramVariant: lead.businessProgramVariant || '',
    courseFees: lead.courseFees ?? null,
    agreedAmount: lead.agreedAmount ?? null,
    discountAmount: lead.discountAmount ?? 0,
    paidAmount: lead.paidAmount ?? null,
  }
  const financialChanged =
    prevFinancial.businessProgramName !== newFinancial.businessProgramName ||
    prevFinancial.businessProgramVariant !== newFinancial.businessProgramVariant ||
    prevFinancial.courseFees !== newFinancial.courseFees ||
    prevFinancial.agreedAmount !== newFinancial.agreedAmount ||
    prevFinancial.discountAmount !== newFinancial.discountAmount ||
    prevFinancial.paidAmount !== newFinancial.paidAmount

  if (financialChanged) {
    lead.financialHistory = lead.financialHistory || []
    lead.financialHistory.unshift({
      previousValues: prevFinancial,
      newValues: newFinancial,
      leadStatus: nextStatus,
      note: String(note || '').trim(),
      changedBy: actorInfo,
      changedAt: new Date(),
    })
  }

  // FRD Section 4: Inquiry Intent Status (Active ONLY for HOT / WARM / COLD; archived in lastInquiryIntent otherwise)
  const isIntentEligible = ['HOT', 'WARM', 'COLD'].includes(nextStatus)
  if (isIntentEligible) {
    if (inquiryIntent !== undefined) {
      const cleanIntent = String(inquiryIntent || '').trim()
      if (cleanIntent && !INQUIRY_INTENT_STATUSES.includes(cleanIntent)) {
        return { error: `Invalid Inquiry Intent Status: "${cleanIntent}"`, statusCode: 400 }
      }
      lead.inquiryIntent = cleanIntent
      if (cleanIntent) {
        lead.lastInquiryIntent = cleanIntent
      }
    }
  } else {
    if (lead.inquiryIntent) {
      lead.lastInquiryIntent = lead.inquiryIntent
    }
    lead.inquiryIntent = ''
  }

  // Record first-reached Milestone History timestamps (FRD Section 7 & 8)
  lead.milestoneHistory = lead.milestoneHistory || {}
  if (nextStatus === 'QUALIFIED BUSINESS' && !lead.milestoneHistory.qualifiedAt) {
    lead.milestoneHistory.qualifiedAt = new Date()
  } else if (nextStatus === 'CONVERTED BUSINESS' && !lead.milestoneHistory.convertedAt) {
    lead.milestoneHistory.convertedAt = new Date()
  } else if (nextStatus === 'ONBOARDED BUSINESS' && !lead.milestoneHistory.onboardedAt) {
    lead.milestoneHistory.onboardedAt = new Date()
  }

  // Update primary lifecycle fields
  lead.leadStatus = nextStatus
  if (matchedCategory) {
    lead.selectedCategory = matchedCategory.key
    lead.selectedCategoryLabel = matchedCategory.label
  }
  lead.heatTier = nextHeatTier

  // Sync legacy status / subStatus
  if (nextStatus === 'NEW LEAD' || nextStatus === 'NON-CONNECT') {
    lead.status = 'Not Contacted'
  } else if (legacyStatus && !matchedCategory && !requestedStatus) {
    lead.status = legacyStatus
  } else {
    lead.status = 'Contacted'
  }
  lead.subStatus = matchedCategory?.label || legacySubStatus || nextStatus

  if (callbackAt !== undefined) lead.callbackAt = callbackAt || null
  if (incrementCallAttempt) {
    lead.callAttempts = (lead.callAttempts || 0) + 1
  }

  // Cycle & End-of-Cycle State Machine
  let autoRecycled = false
  const maxLostCycles = settings.maxLostCycles || 3

  if (nextStatus === 'NON PROSPECT') {
    lead.isCycleEnded = true
    lead.cycleEndReason = 'NON_PROSPECT'
    lead.canRecycle = false
    lead.isDropped = true
    lead.isCompleted = false
  } else if (nextStatus === 'CONVERTED BUSINESS') {
    lead.isCycleEnded = true
    lead.cycleEndReason = 'CONVERTED'
    lead.canRecycle = false
    lead.isCompleted = true
    lead.isDropped = false
    lead.completedAt = lead.completedAt || new Date()
  } else if (nextStatus === 'ONBOARDED BUSINESS') {
    lead.isCycleEnded = true
    lead.cycleEndReason = 'ONBOARDED'
    lead.canRecycle = false
    lead.isCompleted = true
    lead.isDropped = false
    lead.completedAt = lead.completedAt || new Date()
  } else if (nextStatus === 'LOST') {
    lead.lostReason = cleanLostReason || lead.lostReason
    lead.droppedReason = lead.lostReason
    lead.lastLostBy = {
      repId: lead.assignedTo?.repId || actorInfo.userId || null,
      repName: lead.assignedTo?.repName || actorInfo.name || 'Counselor',
      lostAt: new Date(),
    }
    // Increment lostCycleCount when entering LOST from a non-LOST status
    if (prevStatus !== 'LOST') {
      lead.lostCycleCount = (lead.lostCycleCount || 0) + 1
    }
    lead.isDropped = true
    lead.isCompleted = false

    if (lead.lostCycleCount >= maxLostCycles) {
      lead.isCycleEnded = true
      lead.cycleEndReason = 'MAX_LOST_REACHED'
      lead.canRecycle = false
    } else {
      lead.isCycleEnded = false
      lead.cycleEndReason = null
      lead.canRecycle = true
      if (settings.lostRecycleMode === 'auto_pool') {
        autoRecycled = true
      }
    }
  } else if (nextStatus === 'NON-CONNECT') {
    // Keep NON-CONNECT distinct from LOST and still active
    lead.isCycleEnded = false
    lead.cycleEndReason = null
    lead.canRecycle = false
    lead.isDropped = false
    lead.isCompleted = false
  } else {
    // NEW LEAD, HOT, WARM, COLD, QUALIFIED BUSINESS -> active
    lead.isCycleEnded = false
    lead.cycleEndReason = null
    lead.canRecycle = false
    lead.isDropped = false
    lead.isCompleted = false
  }

  // Legacy boolean overrides if caller did not pass categoryKey / leadStatus
  if (!matchedCategory && !requestedStatus) {
    if (isCompleted !== undefined) {
      lead.isCompleted = Boolean(isCompleted)
      if (lead.isCompleted) {
        lead.isDropped = false
        lead.completedAt = lead.completedAt || new Date()
      }
    }
    if (isDropped !== undefined) {
      lead.isDropped = Boolean(isDropped)
      if (lead.isDropped) {
        lead.isCompleted = false
        lead.droppedReason = droppedReason || note || 'Lead dropped / lost'
      }
    }
  }

  // Append chronological Step record
  lead.steps = lead.steps || []
  const nextStepNumber = lead.steps.length + 1
  const stepNote = String(note || '').trim()
  lead.steps.push({
    stepNumber: nextStepNumber,
    cycleNumber: lead.cycleNumber || 1,
    previousStatus: prevStatus,
    newStatus: nextStatus,
    selectedCategory: lead.selectedCategory || '',
    selectedCategoryLabel: lead.selectedCategoryLabel || nextStatus,
    inquiryIntent: lead.inquiryIntent || '',
    heatTier: nextHeatTier,
    note: stepNote || `Updated to ${lead.selectedCategoryLabel || nextStatus}`,
    lostReason: nextStatus === 'LOST' ? lead.lostReason : '',
    callbackAt: lead.callbackAt || null,
    businessSnapshot: {
      businessProgramId: lead.businessProgramId || null,
      businessProgramName: lead.businessProgramName || '',
      businessProgramVariant: lead.businessProgramVariant || '',
      courseFees: lead.courseFees ?? null,
      agreedAmount: lead.agreedAmount ?? null,
      discountAmount: lead.discountAmount ?? 0,
      paidAmount: lead.paidAmount ?? null,
    },
    updatedBy: actorInfo,
    timestamp: new Date(),
  })

  // Also add to legacy notes feed
  lead.notes.unshift({
    text:
      stepNote ||
      `Step #${nextStepNumber}: ${prevStatus} → ${nextStatus}` +
        (lead.selectedCategoryLabel ? ` (${lead.selectedCategoryLabel})` : '') +
        (nextStatus === 'LOST' && lead.lostReason ? ` | Reason: ${lead.lostReason}` : ''),
    author: actorInfo.name,
    status: lead.status,
    subStatus: lead.subStatus,
    timestamp: new Date(),
  })

  // If Admin configured Auto-Recycle to System Pool on recyclable LOST
  if (autoRecycled) {
    lead.cycleNumber = (lead.cycleNumber || 1) + 1
    lead.leadStatus = 'NEW LEAD'
    lead.selectedCategory = ''
    lead.selectedCategoryLabel = ''
    lead.heatTier = null
    lead.status = 'Not Contacted'
    lead.subStatus = `Auto-Recycled to Pool (Cycle #${lead.cycleNumber})`
    lead.assignmentStatus = 'UNASSIGNED'
    lead.assignedTo = null
    lead.canRecycle = false
    lead.isDropped = false
    lead.steps.push({
      stepNumber: lead.steps.length + 1,
      cycleNumber: lead.cycleNumber,
      previousStatus: 'LOST',
      newStatus: 'NEW LEAD',
      selectedCategory: 'auto_recycled',
      selectedCategoryLabel: `Auto-Recycled to System Pool (Cycle #${lead.cycleNumber} of ${maxLostCycles})`,
      heatTier: null,
      note: `Automatically returned to System Pool (Lost cycle ${lead.lostCycleCount}/${maxLostCycles}).`,
      lostReason: lead.lostReason,
      callbackAt: null,
      businessSnapshot: {
        businessProgramId: lead.businessProgramId || null,
        businessProgramName: lead.businessProgramName || '',
        businessProgramVariant: lead.businessProgramVariant || '',
        courseFees: lead.courseFees ?? null,
        paidAmount: lead.paidAmount ?? null,
      },
      updatedBy: { userId: 'system', name: 'Auto-Recycle Policy', role: 'system' },
      timestamp: new Date(),
    })
  }

  return { lead, autoRecycled }
}

// -------------------------------------------------------------
// GET /api/leads (Supports backend pagination by 30)
// -------------------------------------------------------------
export const getLeads = async (req, res) => {
  try {
    const {
      role,
      repId,
      poolOnly,
      status,
      leadStatus,
      heatTier,
      recyclableOnly,
      qualification,
      search,
      page,
      limit,
    } = req.query

    const callerRole = req.user?.role || 'sales'
    const andConditions = []

    // Remove LOST leads from Sales Rep active queue & Team view (Admin sees them in Lost Business & Master list)
    if (callerRole !== 'admin') {
      andConditions.push({ leadStatus: { $ne: 'LOST' } })
    }

    if (poolOnly === 'true') {
      andConditions.push({ assignmentStatus: 'UNASSIGNED' })
    } else {
      // Never show System Pool (UNASSIGNED) leads anywhere outside the Assign Pool tab
      andConditions.push({ assignmentStatus: 'ASSIGNED' })
      if (repId) {
        if (mongoose.Types.ObjectId.isValid(repId)) {
          const objId = new mongoose.Types.ObjectId(repId)
          andConditions.push({
            $or: [
              { 'assignedTo.repId': objId },
              { 'assignedTo.repId': repId },
            ],
          })
        } else {
          const matchedUser = await User.findOne({
            $or: [
              { email: new RegExp(repId, 'i') },
              { name: new RegExp(repId, 'i') },
              { role: 'sales' },
            ],
          })
          if (matchedUser) {
            andConditions.push({
              $or: [
                { 'assignedTo.repId': matchedUser._id },
                { 'assignedTo.repId': matchedUser._id.toString() },
              ],
            })
          }
        }
      }
    }

    if (status && status !== 'All') {
      if (status === 'Unassigned') {
        andConditions.push({ assignmentStatus: 'UNASSIGNED' })
      } else if (status === 'Assigned') {
        andConditions.push({ assignmentStatus: 'ASSIGNED' })
      } else if (['HOT', 'WARM', 'COLD'].includes(status) && callerRole === 'admin') {
        // Admin Hot/Warm/Cold filter includes all leads classified under that heat tier
        // (e.g., COLD includes COLD + NON-CONNECT + NON PROSPECT + LOST; HOT includes HOT + Business milestones)
        andConditions.push({
          $or: [{ leadStatus: status }, { heatTier: status }],
        })
      } else if (status === 'NEW LEAD') {
        andConditions.push({
          $or: [{ leadStatus: 'NEW LEAD' }, { leadStatus: { $exists: false } }, { leadStatus: null }],
        })
      } else if (LEAD_STATUSES.includes(status)) {
        andConditions.push({ leadStatus: status })
      } else {
        andConditions.push({ status })
      }
    }

    if (leadStatus && leadStatus !== 'All' && LEAD_STATUSES.includes(leadStatus)) {
      andConditions.push({ leadStatus })
    }

    // Heat tier filtering is strictly Admin-only
    if (heatTier && heatTier !== 'All' && callerRole === 'admin') {
      andConditions.push({ heatTier })
    }

    if (recyclableOnly === 'true') {
      andConditions.push({ leadStatus: 'LOST', canRecycle: true, isCycleEnded: { $ne: true } })
    }

    if (qualification && qualification !== 'All') {
      andConditions.push({ qualification: new RegExp(qualification, 'i') })
    }

    const searchCond = buildLeadSearchCondition(search)
    if (searchCond) {
      andConditions.push(searchCond)
    }

    const filter = andConditions.length > 0 ? { $and: andConditions } : {}

    // Pagination support
    const isPaginated = page !== undefined || limit !== undefined
    const pageNum = parseInt(page) || 1
    const pageSize = parseInt(limit) || 30
    const skip = (pageNum - 1) * pageSize

    const total = await Lead.countDocuments(filter)

    let queryExec = Lead.find(filter).sort({ createdAt: -1 })
    if (isPaginated) {
      queryExec = queryExec.skip(skip).limit(pageSize)
    }

    const leads = await queryExec.lean()
    const formatted = leads.map(l => sanitizeLeadForRole(l, callerRole))

    if (isPaginated) {
      return res.status(200).json({
        leads: formatted,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / pageSize) || 1,
        limit: pageSize,
      })
    }

    res.status(200).json(formatted)
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/leads/schedule (Next Contact / Follow-Up Schedule for Sales & Admin)
// Returns Selected Day, Next Day, and Overdue callbacks + per-counselor breakdown
// -------------------------------------------------------------
export const getFollowupSchedule = async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin'
    const callerId = String(req.user?.id || req.user?._id || '')
    const {
      date,
      tzOffset = 0,
      repId = 'All',
      search = '',
    } = req.query

    const offsetNum = Number(tzOffset) || 0
    const offsetMs = offsetNum * 60 * 1000

    // Compute selected local YYYY-MM-DD (default to caller's local today)
    let selectedDateStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())
      ? date.trim()
      : null
    if (!selectedDateStr) {
      const localNow = new Date(Date.now() - offsetMs)
      selectedDateStr = localNow.toISOString().slice(0, 10)
    }

    const [y, m, d] = selectedDateStr.split('-').map(Number)
    const selectedDayStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs)
    const selectedDayEnd = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) + offsetMs)
    const nextDayStart = new Date(selectedDayStart.getTime() + 86400000)
    const nextDayEnd = new Date(selectedDayEnd.getTime() + 86400000)
    const nextDateStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)

    // Active assigned leads with a scheduled callbackAt (never System Pool, Lost, Non-Prospect, or Onboarded)
    const andConditions = [
      { assignmentStatus: 'ASSIGNED' },
      { callbackAt: { $ne: null } },
      { leadStatus: { $nin: ['LOST', 'NON PROSPECT', 'ONBOARDED BUSINESS'] } },
      { isCycleEnded: { $ne: true } },
      { isDropped: { $ne: true } },
    ]

    const isManager = !isAdmin && (req.user?.role === 'manager' || Boolean(req.user?.isGroupManager))

    if (isManager) {
      const allGroups = await CounselorGroup.find().lean()
      const managedGroups = allGroups.filter(
        g =>
          (g.managerId && String(g.managerId) === callerId) ||
          (req.user?.groupId && String(g._id) === String(req.user.groupId))
      )
      const teamSet = new Set([callerId])
      for (const g of managedGroups) {
        if (g.managerId) teamSet.add(String(g.managerId))
        for (const m of g.memberIds || []) teamSet.add(String(m))
      }
      const allowedIds = Array.from(teamSet)
      const targetIds =
        repId && repId !== 'All' && allowedIds.includes(String(repId))
          ? [String(repId)]
          : allowedIds
      const idVariants = []
      for (const rid of targetIds) {
        idVariants.push(rid)
        if (mongoose.Types.ObjectId.isValid(rid)) {
          idVariants.push(new mongoose.Types.ObjectId(rid))
        }
      }
      andConditions.push({ 'assignedTo.repId': { $in: idVariants } })
    } else if (!isAdmin) {
      const idVariants = [callerId]
      if (mongoose.Types.ObjectId.isValid(callerId)) {
        idVariants.push(new mongoose.Types.ObjectId(callerId))
      }
      andConditions.push({ 'assignedTo.repId': { $in: idVariants } })
    } else if (repId && repId !== 'All') {
      const idVariants = [repId]
      if (mongoose.Types.ObjectId.isValid(repId)) {
        idVariants.push(new mongoose.Types.ObjectId(repId))
      }
      andConditions.push({ 'assignedTo.repId': { $in: idVariants } })
    }

    const searchCond = buildLeadSearchCondition(search)
    if (searchCond) {
      andConditions.push(searchCond)
    }

    const leads = await Lead.find({ $and: andConditions })
      .sort({ callbackAt: 1 })
      .lean()

    const callerRole = isAdmin ? 'admin' : 'sales'
    const selectedDayLeads = []
    const nextDayLeads = []
    const overdueLeads = []
    let laterCount = 0

    const counselorMap = {}

    for (const rawLead of leads) {
      const cb = rawLead.callbackAt ? new Date(rawLead.callbackAt) : null
      if (!cb || Number.isNaN(cb.getTime())) continue

      const formatted = sanitizeLeadForRole(rawLead, callerRole)
      const rId = rawLead.assignedTo?.repId ? String(rawLead.assignedTo.repId) : 'unassigned'
      const rName = rawLead.assignedTo?.repName || 'Unassigned'
      if (!counselorMap[rId]) {
        counselorMap[rId] = {
          repId: rId,
          repName: rName,
          selectedDayCount: 0,
          nextDayCount: 0,
          overdueCount: 0,
          totalCount: 0,
        }
      }

      if (cb >= selectedDayStart && cb <= selectedDayEnd) {
        selectedDayLeads.push(formatted)
        counselorMap[rId].selectedDayCount++
        counselorMap[rId].totalCount++
      } else if (cb >= nextDayStart && cb <= nextDayEnd) {
        nextDayLeads.push(formatted)
        counselorMap[rId].nextDayCount++
        counselorMap[rId].totalCount++
      } else if (cb < selectedDayStart) {
        overdueLeads.push(formatted)
        counselorMap[rId].overdueCount++
        counselorMap[rId].totalCount++
      } else {
        laterCount++
      }
    }

    const byCounselor = Object.values(counselorMap).sort(
      (a, b) => (b.selectedDayCount + b.overdueCount) - (a.selectedDayCount + a.overdueCount)
    )

    res.status(200).json({
      success: true,
      selectedDate: selectedDateStr,
      nextDate: nextDateStr,
      counts: {
        selectedDay: selectedDayLeads.length,
        nextDay: nextDayLeads.length,
        overdue: overdueLeads.length,
        later: laterCount,
      },
      selectedDayLeads,
      nextDayLeads,
      overdueLeads,
      byCounselor: isAdmin ? byCounselor : undefined,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/leads/reps
// -------------------------------------------------------------
export const getSalesRepsList = async (req, res) => {
  try {
    const includeInactive = req.query?.includeInactive === 'true'
    const repFilter = includeInactive ? { role: 'sales' } : { role: 'sales', active: { $ne: false } }
    const reps = await User.find(repFilter).lean()

    const repStats = await Promise.all(
      reps.map(async rep => {
        const repId = rep._id
        const assignedCount = await Lead.countDocuments({ 'assignedTo.repId': repId })
        const contactedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          status: 'Contacted',
        })
        const notContactedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          status: 'Not Contacted',
        })
        const enrolledCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          subStatus: { $regex: /enrolled/i },
        })

        const completedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          isCompleted: true,
        })
        const droppedCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          isDropped: true,
        })
        const activeCount = await Lead.countDocuments({
          'assignedTo.repId': repId,
          isCompleted: { $ne: true },
          isDropped: { $ne: true },
        })

        const contactRate = assignedCount > 0 ? Math.round((contactedCount / assignedCount) * 100) : 0

        return {
          id: rep._id.toString(),
          _id: rep._id.toString(),
          name: rep.name,
          email: rep.email,
          role: rep.title || rep.role,
          title: rep.title,
          specialty: rep.specialty,
          avatar: rep.avatar,
          active: rep.active,
          groupId: rep.groupId || null,
          isGroupManager: Boolean(rep.isGroupManager),
          totalAssigned: assignedCount,
          assignedCount,
          activeCount,
          completedCount,
          droppedCount,
          contactedCount,
          notContactedCount,
          enrolledCount,
          contactRate,
        }
      })
    )

    res.status(200).json(repStats)
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/upload (XLSX, XLS, CSV, TSV) -> Database
// -------------------------------------------------------------
export const uploadLeads = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }

    const parsed = parseLeadsData(req.file.buffer, true)
    if (!parsed || parsed.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid leads extracted from file' })
    }

    let addedCount = 0
    let duplicateCount = 0
    const leadsToInsert = []

    for (const item of parsed) {
      const orConditions = []
      if (item.phone) orConditions.push({ phone: item.phone })
      if (item.email) orConditions.push({ email: item.email.toLowerCase() })
      if (item.metaLeadId) orConditions.push({ metaLeadId: item.metaLeadId })

      let isDuplicate = false
      if (orConditions.length > 0) {
        const existing = await Lead.findOne({ $or: orConditions })
        if (existing) isDuplicate = true
      }

      if (isDuplicate) {
        duplicateCount++
      } else {
        leadsToInsert.push({
          metaLeadId: item.metaLeadId,
          fullName: item.fullName,
          phone: item.phone,
          email: item.email,
          qualification: item.qualification,
          preferredLocation: item.preferredLocation,
          learningMode: item.learningMode,
          interestReason: item.interestReason,
          careerRole: item.careerRole,
          platform: item.platform,
          campaignName: item.campaignName,
          adsetName: item.adsetName,
          adName: item.adName,
          formName: item.formName,
          customFields: item.customFields,
          createdTime: new Date(),
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          callAttempts: 0,
          callbackAt: null,
          notes: [
            {
              text: `Ingested from ${item.platform} file upload ("${item.formName}")`,
              author: 'File Ingestion Engine',
              status: 'Not Contacted',
              subStatus: 'New Lead In Pool',
              timestamp: new Date(),
            },
          ],
        })
        addedCount++
      }
    }

    if (leadsToInsert.length > 0) {
      await Lead.insertMany(leadsToInsert)
    }

    const totalPoolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })

    res.status(200).json({
      success: true,
      message: `File processed successfully. Added ${addedCount} new leads to MongoDB pool (${duplicateCount} duplicates ignored).`,
      addedCount,
      duplicateCount,
      totalPoolCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: `Upload failed: ${error.message}` })
  }
}

// -------------------------------------------------------------
// POST /api/leads/paste (Raw TSV/CSV) -> Database
// -------------------------------------------------------------
export const pasteLeads = async (req, res) => {
  try {
    const { text } = req.body
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'No text provided' })
    }

    const parsed = parseLeadsData(text, false)
    if (!parsed || parsed.length === 0) {
      return res.status(400).json({ success: false, message: 'Could not extract leads from pasted text' })
    }

    let addedCount = 0
    let duplicateCount = 0
    const leadsToInsert = []

    for (const item of parsed) {
      const orConditions = []
      if (item.phone) orConditions.push({ phone: item.phone })
      if (item.email) orConditions.push({ email: item.email.toLowerCase() })
      if (item.metaLeadId) orConditions.push({ metaLeadId: item.metaLeadId })

      let isDuplicate = false
      if (orConditions.length > 0) {
        const existing = await Lead.findOne({ $or: orConditions })
        if (existing) isDuplicate = true
      }

      if (isDuplicate) {
        duplicateCount++
      } else {
        leadsToInsert.push({
          metaLeadId: item.metaLeadId,
          fullName: item.fullName,
          phone: item.phone,
          email: item.email,
          qualification: item.qualification,
          preferredLocation: item.preferredLocation,
          learningMode: item.learningMode,
          interestReason: item.interestReason,
          careerRole: item.careerRole,
          platform: item.platform,
          campaignName: item.campaignName,
          adsetName: item.adsetName,
          adName: item.adName,
          formName: item.formName,
          customFields: item.customFields,
          createdTime: new Date(),
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          status: 'Not Contacted',
          subStatus: 'New Lead In Pool',
          callAttempts: 0,
          callbackAt: null,
          notes: [
            {
              text: `Ingested from direct text paste ("${item.formName}")`,
              author: 'Meta Paste Engine',
              status: 'Not Contacted',
              subStatus: 'New Lead In Pool',
              timestamp: new Date(),
            },
          ],
        })
        addedCount++
      }
    }

    if (leadsToInsert.length > 0) {
      await Lead.insertMany(leadsToInsert)
    }

    const totalPoolCount = await Lead.countDocuments({ assignmentStatus: 'UNASSIGNED' })

    res.status(200).json({
      success: true,
      message: `Parsed & saved to MongoDB. Added ${addedCount} new leads (${duplicateCount} duplicates skipped).`,
      addedCount,
      duplicateCount,
      totalPoolCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/leads/:id (Fetch single lead by ID for Profile view)
// -------------------------------------------------------------
export const getLeadById = async (req, res) => {
  try {
    const { id } = req.params
    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found in database' })
    }
    const formatted = sanitizeLeadForRole(lead, req.user?.role || 'sales')
    return res.status(200).json({ success: true, lead: formatted })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}


// -------------------------------------------------------------
// POST /api/leads/assign (Manual assignment in MongoDB)
// -------------------------------------------------------------
export const assignLeads = async (req, res) => {
  try {
    const { leadIds, repId, applyToAll = false, scope, search } = req.body || {}

    const isEntirePool = Boolean(applyToAll) && scope === 'pool'
    if (!isEntirePool && (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0)) {
      return res.status(400).json({ success: false, message: 'leadIds array is required' })
    }

    let rep = null
    if (mongoose.Types.ObjectId.isValid(repId)) {
      rep = await User.findById(repId)
    }
    if (!rep) {
      rep = await User.findOne({
        $or: [
          { email: new RegExp(repId, 'i') },
          { name: new RegExp(repId, 'i') },
          { role: 'sales' },
        ],
      })
    }
    if (!rep) {
      return res.status(404).json({ success: false, message: 'Sales Representative not found in database' })
    }

    let filterQuery
    if (isEntirePool) {
      const searchCond = buildLeadSearchCondition(search)
      filterQuery = searchCond
        ? { $and: [{ assignmentStatus: 'UNASSIGNED' }, searchCond] }
        : { assignmentStatus: 'UNASSIGNED' }
    } else {
      filterQuery = { _id: { $in: leadIds } }
    }

    const now = new Date()
    const assignedObj = {
      repId: rep._id,
      repName: rep.name,
      repRole: rep.title || rep.role,
      assignedAt: now,
    }

    // Preserve initialAdvisor on first assignment (never overwrite if already set)
    await Lead.updateMany(
      {
        $and: [
          filterQuery,
          {
            $or: [
              { initialAdvisor: { $exists: false } },
              { initialAdvisor: null },
              { 'initialAdvisor.repId': { $exists: false } },
              { 'initialAdvisor.repId': null },
            ],
          },
        ],
      },
      {
        $set: {
          initialAdvisor: assignedObj,
        },
      }
    )

    const updateResult = await Lead.updateMany(
      filterQuery,
      {
        $set: {
          assignmentStatus: 'ASSIGNED',
          assignedTo: assignedObj,
          groupId: rep.groupId || null,
          subStatus: 'Assigned - Pending First Call',
        },
        $push: {
          notes: {
            $each: [
              {
                text: `Manually assigned to ${rep.name} (${rep.title})`,
                author: 'Admin',
                status: 'Not Contacted',
                subStatus: 'Assigned - Pending First Call',
                timestamp: now,
              },
            ],
            $position: 0,
          },
        },
      }
    )

    if (updateResult.modifiedCount > 0) {
      let leadLabel = `${updateResult.modifiedCount} Lead(s)`
      let leadPhone = 'Multiple'
      let leadCourse = 'Various'
      if (updateResult.modifiedCount === 1 && !isEntirePool && Array.isArray(leadIds) && leadIds.length === 1) {
        const singleLead = await Lead.findById(leadIds[0]).select('fullName phone courseProgram').lean()
        if (singleLead) {
          leadLabel = singleLead.fullName || leadLabel
          leadPhone = singleLead.phone || 'N/A'
          leadCourse = singleLead.courseProgram || 'Not Specified'
        }
      }
      notifyTelegramEvent(
        'leadAssigned',
        {
          leadName: leadLabel,
          phone: leadPhone,
          course: leadCourse,
          assignedBy: req.user?.name || 'Administrator',
          count: String(updateResult.modifiedCount),
        },
        { targetUserIds: [rep._id.toString()] }
      )
    }

    res.status(200).json({
      success: true,
      message: `Successfully assigned ${updateResult.modifiedCount} lead(s) to ${rep.name}`,
      count: updateResult.modifiedCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/auto-assign (Round-Robin Bulk Allocation in MongoDB)
// -------------------------------------------------------------
export const autoAssignLeads = async (req, res) => {
  try {
    const { leadIds, search } = req.body || {}

    const allReps = await User.find({
      role: { $in: ['sales', 'manager'] },
      active: { $ne: false },
      receiveLeads: { $ne: false },
    }).lean()
    const activeReps = allReps.filter(r => !isCounselorPaused(r))
    if (!activeReps || activeReps.length === 0) {
      return res.status(400).json({
        success: false,
        message: allReps.length > 0
          ? 'All sales reps are currently paused from receiving leads'
          : 'No active sales reps found in database',
      })
    }

    let query = { assignmentStatus: 'UNASSIGNED' }
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      const validIds = leadIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id))
      if (validIds.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid leadIds provided' })
      }
      query = { _id: { $in: validIds } }
    } else {
      const searchCond = buildLeadSearchCondition(search)
      if (searchCond) {
        query = { $and: [{ assignmentStatus: 'UNASSIGNED' }, searchCond] }
      }
    }

    // Fetch minimal fields (.lean) and use bulkWrite so legacy schema validation or large pools never 500
    const targetLeads = await Lead.find(query).select('_id status initialAdvisor').lean()
    if (targetLeads.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No unassigned leads in pool to allocate.',
        assignedCount: 0,
      })
    }

    const now = new Date()
    let repIndex = 0
    const distribution = {}
    activeReps.forEach(r => (distribution[r.name] = 0))

    const bulkOps = targetLeads.map(lead => {
      const chosenRep = activeReps[repIndex % activeReps.length]
      repIndex++
      distribution[chosenRep.name]++

      const assignedObj = {
        repId: chosenRep._id,
        repName: chosenRep.name,
        repRole: chosenRep.title || chosenRep.role || 'Admissions Counselor',
        assignedAt: now,
      }

      const setPayload = {
        assignmentStatus: 'ASSIGNED',
        assignedTo: assignedObj,
        groupId: chosenRep.groupId || null,
        subStatus: 'Assigned - Pending First Call',
      }
      if (!lead.initialAdvisor?.repId) {
        setPayload.initialAdvisor = assignedObj
      }

      return {
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: setPayload,
            $push: {
              notes: {
                $each: [
                  {
                    text: `Auto-assigned to ${chosenRep.name} (Round-Robin Engine)`,
                    author: 'System Allocator',
                    status: lead.status || 'Not Contacted',
                    subStatus: 'Assigned - Pending First Call',
                    timestamp: now,
                  },
                ],
                $position: 0,
              },
            },
          },
        },
      }
    })

    const bulkResult = await Lead.bulkWrite(bulkOps, { ordered: false })
    const assignedCount = bulkResult.modifiedCount ?? targetLeads.length

    // Notify each rep who received auto-assigned leads
    if (assignedCount > 0 && Array.isArray(activeReps)) {
      for (const rep of activeReps) {
        const repKey = rep.name
        const repCount = distribution?.[repKey] || 0
        if (repCount > 0) {
          notifyTelegramEvent(
            'leadAssigned',
            {
              leadName: `${repCount} Auto-Assigned Lead${repCount === 1 ? '' : 's'}`,
              phone: 'Check CRM Queue',
              course: 'Round-Robin Allocation',
              assignedBy: req.user?.name || 'Auto Round-Robin',
              count: String(repCount),
            },
            { targetUserIds: [rep._id.toString()] }
          )
        }
      }
    }

    res.status(200).json({
      success: true,
      message: `Auto-assigned ${assignedCount} leads across ${activeReps.length} sales reps.`,
      assignedCount,
      distribution,
    })
  } catch (error) {
    console.error('[autoAssignLeads] Error:', error)
    res.status(500).json({ success: false, message: error.message || 'Auto-assignment failed' })
  }
}

// -------------------------------------------------------------
// POST /api/leads/unassign (Return leads to pool in MongoDB)
// -------------------------------------------------------------
export const unassignLeads = async (req, res) => {
  try {
    const { leadIds } = req.body
    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, message: 'leadIds array required' })
    }

    // Preserve initialAdvisor from current assignedTo before unassigning
    await Lead.updateMany(
      {
        _id: { $in: leadIds },
        'assignedTo.repId': { $exists: true, $ne: null },
        $or: [
          { initialAdvisor: { $exists: false } },
          { initialAdvisor: null },
          { 'initialAdvisor.repId': { $exists: false } },
          { 'initialAdvisor.repId': null },
        ],
      },
      [{ $set: { initialAdvisor: '$assignedTo' } }]
    )

    const result = await Lead.updateMany(
      { _id: { $in: leadIds } },
      {
        $set: {
          assignmentStatus: 'UNASSIGNED',
          assignedTo: null,
          subStatus: 'Returned to Pool',
        },
        $push: {
          notes: {
            $each: [
              {
                text: 'Returned to Unassigned Pool by Admin',
                author: 'Admin',
                status: 'Not Contacted',
                subStatus: 'Returned to Pool',
                timestamp: new Date(),
              },
            ],
            $position: 0,
          },
        },
      }
    )

    res.status(200).json({
      success: true,
      message: `Returned ${result.modifiedCount} lead(s) back to the unassigned pool.`,
      count: result.modifiedCount,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

export async function syncReferralForLead(lead) {
  try {
    if (!lead || !lead._id) return
    const refDoc = await Referral.findOne({ referredLeadId: lead._id })
    if (!refDoc) return

    refDoc.leadStatus = lead.leadStatus || 'NEW LEAD'
    refDoc.courseFees = Number(lead.courseFees) || 0
    refDoc.agreedAmount = lead.agreedAmount !== null && lead.agreedAmount !== undefined ? Number(lead.agreedAmount) : (Number(lead.courseFees) || 0)
    refDoc.discountAmount = Number(lead.discountAmount) || 0
    refDoc.paidAmount = Number(lead.paidAmount) || 0
    refDoc.isQualified = (Number(lead.paidAmount) || 0) > 0 && (Number(lead.paidAmount) || 0) < 10000
    refDoc.isConverted =
      (Number(lead.paidAmount) || 0) >= 10000 ||
      lead.leadStatus === 'CONVERTED BUSINESS' ||
      lead.leadStatus === 'ONBOARDED BUSINESS'
    refDoc.isOnboarded = lead.leadStatus === 'ONBOARDED BUSINESS'
    if (refDoc.isConverted && !refDoc.convertedAt) {
      refDoc.convertedAt = lead.milestoneHistory?.convertedAt || new Date()
    }
    if (refDoc.isOnboarded && !refDoc.onboardedAt) {
      refDoc.onboardedAt = lead.milestoneHistory?.onboardedAt || new Date()
    }
    if (lead.assignedTo?.repId) {
      refDoc.assignedCounselor = {
        repId: lead.assignedTo.repId,
        repName: lead.assignedTo.repName,
      }
    }
    await refDoc.save()
  } catch (err) {
    console.error('Error syncing referral for lead:', err)
  }
}

// -------------------------------------------------------------
// PATCH /api/leads/:id/status & POST /api/leads/:id/steps
// Only Admin or the assigned Sales Counselor may update status & add steps
// -------------------------------------------------------------
export const updateLeadStatus = async (req, res) => {
  try {
    const { id } = req.params
    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found in database' })
    }

    // Permission enforcement: Admin or Assigned Sales Counselor only
    const actor = req.user
    const isAdmin = actor?.role === 'admin'
    if (actor && !isAdmin && !isLeadAssignedToUser(lead, actor)) {
      return res.status(403).json({
        success: false,
        message: 'You can only update status and add steps on leads assigned to you.',
      })
    }

    // Lock guard: While a Discount Approval is PENDING, status updates are locked until Admin decides
    if (lead.discountApprovalStatus === 'PENDING' && !isAdmin) {
      return res.status(409).json({
        success: false,
        code: 'DISCOUNT_APPROVAL_PENDING',
        message: 'This lead is locked pending Admin discount approval. Wait for Admin to approve or reject.',
      })
    }

    const settings = await getOrCreateCrmSettings()
    const body = req.body || {}

    // Intercept Sales Rep / Group Manager discount requests on Qualified / Converted Business
    // Status change & discount are held as PENDING until Admin approves
    if (!isAdmin && body.agreedAmount !== undefined && body.agreedAmount !== '' && body.agreedAmount !== null) {
      const matchedCat = body.categoryKey
        ? (settings.outcomeCategories || []).find(
            c => c.key === String(body.categoryKey).trim() && c.active !== false
          )
        : null
      const targetStatus = matchedCat?.leadStatus || body.leadStatus || lead.leadStatus || 'NEW LEAD'

      if (['QUALIFIED BUSINESS', 'CONVERTED BUSINESS'].includes(targetStatus)) {
        const stdFee =
          body.courseFees !== undefined && body.courseFees !== '' && body.courseFees !== null
            ? Number(body.courseFees)
            : Number(lead.courseFees) || 0
        const reqAgreed = Number(body.agreedAmount)

        if (stdFee > 0 && reqAgreed < stdFee) {
          // Check if this exact agreedAmount was already approved on this lead
          const alreadyApprovedSameAmount =
            lead.discountApprovalStatus === 'APPROVED' &&
            lead.agreedAmount !== null &&
            Number(lead.agreedAmount) === reqAgreed &&
            Number(lead.courseFees) === stdFee

          if (!alreadyApprovedSameAmount) {
            if (reqAgreed < 0) {
              return res.status(400).json({ success: false, message: 'Agreed Amount cannot be negative.' })
            }

            // Validate Discount Reason
            const cleanReason = String(body.discountReason || '').trim()
            const cleanReasonDesc = String(body.discountReasonDescription || '').trim()
            if (!DISCOUNT_REASONS.includes(cleanReason)) {
              return res.status(400).json({
                success: false,
                message: 'Please select a valid Discount Reason (Referral, Lump Sum Discount, Spot Admission Discount, or Other).',
              })
            }
            if (cleanReason === 'Other' && !cleanReasonDesc) {
              return res.status(400).json({
                success: false,
                message: 'Please enter a description when Discount Reason is Other.',
              })
            }

            // Pre-validate payment threshold rules so invalid requests fail immediately
            const existingReceipts = Array.isArray(lead.paymentReceipts) ? lead.paymentReceipts : []
            const existingReceiptSum = existingReceipts.reduce((s, r) => s + (Number(r.amount) || 0), 0)
            const newRecAmt =
              body.newReceipt && body.newReceipt.amount !== undefined && Number(body.newReceipt.amount) > 0
                ? Number(body.newReceipt.amount)
                : 0
            const projectedPaid =
              newRecAmt > 0
                ? (existingReceipts.length > 0 ? existingReceiptSum : Number(lead.paidAmount) || 0) + newRecAmt
                : body.paidAmount !== undefined && body.paidAmount !== ''
                ? Number(body.paidAmount)
                : Number(lead.paidAmount) || 0

            if (targetStatus === 'CONVERTED BUSINESS' && projectedPaid < 10000) {
              return res.status(400).json({
                success: false,
                message: "Can't update step: Total amount is not ₹10,000 or above for Converted Business. For advance/token payments below ₹10,000, please select Qualified.",
              })
            }
            if (targetStatus === 'QUALIFIED BUSINESS' && projectedPaid >= 10000) {
              return res.status(400).json({
                success: false,
                message: "Can't update step: Total amount is ₹10,000 or above. Qualified Business is strictly for advance/token payments below ₹10,000. Please select Converted Business.",
              })
            }

            const reqDiscount = Math.max(0, stdFee - reqAgreed)
            const approvalDoc = await DiscountApproval.create({
              leadId: lead._id,
              leadName: lead.fullName,
              leadPhone: lead.phone || '',
              previousStatus: lead.leadStatus || 'NEW LEAD',
              targetStatus,
              categoryKey: body.categoryKey || '',
              programId: body.businessProgramId && mongoose.Types.ObjectId.isValid(body.businessProgramId)
                ? body.businessProgramId
                : lead.businessProgramId || null,
              programName: body.businessProgramName || lead.businessProgramName || '',
              programVariant: body.businessProgramVariant || lead.businessProgramVariant || '',
              standardCourseFee: stdFee,
              requestedAgreedAmount: reqAgreed,
              requestedDiscountAmount: reqDiscount,
              discountReason: cleanReason,
              discountReasonDescription: cleanReasonDesc,
              pendingPayload: body,
              requestedBy: {
                userId: actor?.id || actor?._id || '',
                name: actor?.name || body.author || 'Staff',
                role: actor?.role || 'sales',
              },
              groupId: lead.groupId || null,
              status: 'PENDING',
            })

            lead.discountApprovalStatus = 'PENDING'
            lead.pendingDiscountRequestId = approvalDoc._id
            lead.notes = lead.notes || []
            lead.notes.unshift({
              text: `Discount approval requested for ${targetStatus}: Standard ₹${stdFee.toLocaleString('en-IN')} → Agreed ₹${reqAgreed.toLocaleString('en-IN')} (Discount ₹${reqDiscount.toLocaleString('en-IN')}) | Reason: ${cleanReason}${cleanReasonDesc ? ` — ${cleanReasonDesc}` : ''}. Lead locked pending Admin approval.`,
              author: actor?.name || 'Staff',
              status: lead.status,
              subStatus: lead.subStatus,
              timestamp: new Date(),
            })
            await lead.save()

            // Alert Admins via Telegram about pending discount approval request
            notifyTelegramEvent(
              'discountRequested',
              {
                leadName: lead.fullName || 'Lead',
                phone: lead.phone || 'N/A',
                course: approvalDoc.programName || lead.courseProgram || 'Not Specified',
                standardFee: formatMoneyIN(stdFee),
                agreedAmount: formatMoneyIN(reqAgreed),
                discountAmount: formatMoneyIN(reqDiscount),
                reason: `${cleanReason}${cleanReasonDesc ? ` (${cleanReasonDesc})` : ''}`,
                requestedBy: actor?.name || body.author || 'Staff',
              },
              { notifyAdmins: true }
            )

            const formatted = sanitizeLeadForRole(lead, actor?.role || 'sales')
            return res.status(200).json({
              success: true,
              pendingApproval: true,
              approvalRequest: { ...approvalDoc.toObject(), id: approvalDoc._id.toString() },
              message: `Discount approval request submitted (Discount: ₹${reqDiscount.toLocaleString('en-IN')}). Lead status is locked as Pending until Admin approves.`,
              lead: formatted,
            })
          }
        }
      }
    }

    const prevStatusBeforeUpdate = lead.leadStatus
    const result = await applyLifecycleUpdate(lead, body, actor, settings)
    if (result.error) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.error,
      })
    }

    await lead.save()
    await syncReferralForLead(lead)

    // Alert Admins via Telegram when a lead reaches a Business Milestone
    if (
      BUSINESS_STATUSES.includes(lead.leadStatus) &&
      lead.leadStatus !== prevStatusBeforeUpdate
    ) {
      const effectiveAgreed =
        lead.agreedAmount !== null && lead.agreedAmount !== undefined
          ? lead.agreedAmount
          : lead.courseFees
      notifyTelegramEvent(
        'businessMilestone',
        {
          status: lead.leadStatus,
          leadName: lead.fullName || 'Lead',
          phone: lead.phone || 'N/A',
          course: lead.businessProgramName || lead.courseProgram || 'Not Specified',
          agreedAmount: formatMoneyIN(effectiveAgreed),
          paidAmount: formatMoneyIN(lead.paidAmount),
          assignedTo: lead.assignedTo?.repName || actor?.name || 'Unassigned',
        },
        { notifyAdmins: true }
      )
    }

    const formatted = sanitizeLeadForRole(lead, actor?.role || 'sales')

    res.status(200).json({
      success: true,
      autoRecycled: actor?.role === 'admin' ? result.autoRecycled || false : undefined,
      message:
        actor?.role === 'admin' && result.autoRecycled
          ? `Lead marked LOST and auto-recycled back to System Pool (Cycle #${lead.cycleNumber}).`
          : 'Lead step & status updated successfully',
      lead: formatted,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// Alias endpoint specifically for step-by-step updates
export const addLeadStep = updateLeadStatus

// -------------------------------------------------------------
// POST /api/leads/:id/receipts (Add Installment Payment Receipt — auto-sums Paid Amount)
// -------------------------------------------------------------
export const addLeadPaymentReceipt = async (req, res) => {
  try {
    const { id } = req.params
    const { amount, receiptDate, paymentMode = 'UPI', referenceNo = '', note = '' } = req.body || {}

    const amtNum = Number(amount)
    if (Number.isNaN(amtNum) || amtNum <= 0) {
      return res.status(400).json({ success: false, message: 'Receipt amount must be greater than 0.' })
    }

    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    const actor = req.user || null
    const isAdmin = actor?.role === 'admin'
    if (actor && !isAdmin && !isLeadAssignedToUser(lead, actor)) {
      return res.status(403).json({
        success: false,
        message: 'You can only record payment receipts for leads assigned to you.',
      })
    }

    const settings = await getOrCreateCrmSettings()
    if (!isAdmin && !settings.allowSalesFinancialEdit) {
      return res.status(403).json({
        success: false,
        message: 'Financial receipt editing is restricted to Administrators.',
      })
    }

    const prevFinancial = {
      businessProgramName: lead.businessProgramName || '',
      businessProgramVariant: lead.businessProgramVariant || '',
      courseFees: lead.courseFees ?? null,
      paidAmount: lead.paidAmount ?? null,
    }

    const actorInfo = {
      userId: actor?.id || actor?._id || '',
      name: actor?.name || 'Staff',
      role: actor?.role || 'sales',
    }

    lead.paymentReceipts = lead.paymentReceipts || []
    if (lead.paymentReceipts.length === 0 && (Number(lead.paidAmount) || 0) > 0) {
      lead.paymentReceipts.push({
        amount: Number(lead.paidAmount),
        receiptDate: lead.updatedAt || new Date(),
        paymentMode: 'Other',
        referenceNo: 'PREV-RECORDED',
        note: 'Previously recorded amount before itemized receipts',
        recordedBy: { userId: 'system', name: 'System Migration', role: 'system' },
        createdAt: lead.updatedAt || new Date(),
      })
    }

    const receiptEntry = {
      amount: amtNum,
      receiptDate: receiptDate ? new Date(receiptDate) : new Date(),
      paymentMode: paymentMode || 'UPI',
      referenceNo: String(referenceNo || '').trim(),
      note: String(note || '').trim(),
      recordedBy: actorInfo,
      createdAt: new Date(),
    }
    lead.paymentReceipts.push(receiptEntry)
    lead.paidAmount = lead.paymentReceipts.reduce((s, r) => s + (Number(r.amount) || 0), 0)
    lead.overpaidFlag = Boolean(
      lead.courseFees !== null &&
        lead.courseFees !== undefined &&
        lead.courseFees > 0 &&
        lead.paidAmount > Number(lead.courseFees)
    )

    lead.financialHistory = lead.financialHistory || []
    lead.financialHistory.unshift({
      previousValues: prevFinancial,
      newValues: {
        businessProgramName: lead.businessProgramName || '',
        businessProgramVariant: lead.businessProgramVariant || '',
        courseFees: lead.courseFees ?? null,
        paidAmount: lead.paidAmount,
      },
      leadStatus: lead.leadStatus || 'NEW LEAD',
      note: `Receipt ₹${amtNum.toLocaleString('en-IN')} (${receiptEntry.paymentMode}${receiptEntry.referenceNo ? ` • Ref: ${receiptEntry.referenceNo}` : ''})${receiptEntry.note ? ` — ${receiptEntry.note}` : ''}`,
      changedBy: actorInfo,
      changedAt: new Date(),
    })

    lead.notes = lead.notes || []
    lead.notes.unshift({
      text: `Payment receipt recorded: ₹${amtNum.toLocaleString('en-IN')} via ${receiptEntry.paymentMode}${receiptEntry.referenceNo ? ` (Ref: ${receiptEntry.referenceNo})` : ''}. Total Paid: ₹${lead.paidAmount.toLocaleString('en-IN')}.`,
      author: actorInfo.name,
      status: lead.status,
      subStatus: lead.subStatus,
      timestamp: new Date(),
    })

    await lead.save()
    const callerRole = actor?.role || 'sales'
    res.status(200).json({
      success: true,
      message: lead.overpaidFlag
        ? `Receipt ₹${amtNum.toLocaleString('en-IN')} saved. Note: Total paid exceeds Course Fees (flagged for review).`
        : `Payment receipt of ₹${amtNum.toLocaleString('en-IN')} recorded. Total Paid: ₹${lead.paidAmount.toLocaleString('en-IN')}.`,
      lead: sanitizeLeadForRole(lead, callerRole),
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/:id/recycle (Admin-only: Recycle a single LOST lead)
// Supports recycleMethod: 'pool' | 'specific' | 'round-robin', plus force override
// -------------------------------------------------------------
export const recycleLead = async (req, res) => {
  try {
    const { id } = req.params
    const { recycleMethod, targetRepId, note, force } = req.body || {}

    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    const settings = await getOrCreateCrmSettings()
    const maxLostCycles = settings.maxLostCycles || 3

    if (lead.leadStatus !== 'LOST') {
      return res.status(400).json({
        success: false,
        message: `Only LOST leads can be recycled (current status: ${lead.leadStatus}).`,
      })
    }

    if (lead.lostCycleCount >= maxLostCycles && !force) {
      return res.status(400).json({
        success: false,
        message: `Lead has reached the maximum allowed Lost cycles (${lead.lostCycleCount}/${maxLostCycles}). Enable Admin Override to force recycle.`,
      })
    }

    const method =
      recycleMethod ||
      (targetRepId && mongoose.Types.ObjectId.isValid(targetRepId) ? 'specific' : 'pool')

    let assignedRep = null
    if (method === 'specific' && targetRepId && mongoose.Types.ObjectId.isValid(targetRepId)) {
      assignedRep = await User.findById(targetRepId)
      if (!assignedRep) {
        return res.status(404).json({ success: false, message: 'Target counselor not found.' })
      }
    } else if (method === 'round-robin') {
      const prevRepId = lead.lastLostBy?.repId || lead.assignedTo?.repId || null
      assignedRep = await pickRoundRobinCounselor(prevRepId)
    }

    lead.cycleNumber = (lead.cycleNumber || 1) + 1
    lead.leadStatus = 'NEW LEAD'
    lead.selectedCategory = ''
    lead.selectedCategoryLabel = ''
    lead.heatTier = null
    lead.status = 'Not Contacted'
    lead.canRecycle = false
    lead.isDropped = false
    lead.isCompleted = false
    lead.isCycleEnded = false
    lead.cycleEndReason = null

    // Preserve initialAdvisor before changing assignedTo on recycle
    if (!lead.initialAdvisor?.repId) {
      if (lead.assignedTo?.repId) {
        lead.initialAdvisor = { ...lead.assignedTo }
      } else if (lead.lastLostBy?.repId) {
        lead.initialAdvisor = {
          repId: lead.lastLostBy.repId,
          repName: lead.lastLostBy.repName,
          repRole: 'Admissions Counselor',
          assignedAt: lead.lastLostBy.lostAt || lead.createdAt,
        }
      }
    }

    let destinationText = 'System Pool (Unassigned)'
    if (assignedRep) {
      const nextAssigned = {
        repId: assignedRep._id,
        repName: assignedRep.name,
        repRole: assignedRep.title || 'Admissions Counselor',
        assignedAt: new Date(),
      }
      lead.assignmentStatus = 'ASSIGNED'
      lead.assignedTo = nextAssigned
      if (!lead.initialAdvisor?.repId) {
        lead.initialAdvisor = nextAssigned
      }
      lead.groupId = assignedRep.groupId || null
      lead.subStatus =
        method === 'round-robin'
          ? `Auto-Recycled (Round-Robin) to ${assignedRep.name} (Cycle #${lead.cycleNumber})`
          : `Recycled to ${assignedRep.name} (Cycle #${lead.cycleNumber})`
      destinationText = `${assignedRep.name}${method === 'round-robin' ? ' (Auto Round-Robin)' : ''}`
    } else {
      lead.assignmentStatus = 'UNASSIGNED'
      lead.assignedTo = null
      lead.subStatus = `Recycled to System Pool (Cycle #${lead.cycleNumber})`
    }

    const actorInfo = {
      userId: req.user?.id || '',
      name: req.user?.name || 'Admin',
      role: req.user?.role || 'admin',
    }

    lead.steps = lead.steps || []
    lead.steps.push({
      stepNumber: lead.steps.length + 1,
      cycleNumber: lead.cycleNumber,
      previousStatus: 'LOST',
      newStatus: 'NEW LEAD',
      selectedCategory: 'admin_recycled',
      selectedCategoryLabel: `${force ? 'Admin Override Recycle' : 'Recycled by Admin'} → ${destinationText} (Cycle #${lead.cycleNumber})`,
      heatTier: null,
      note:
        String(note || '').trim() ||
        `Recycled by ${actorInfo.name} into ${destinationText} (Cycle #${lead.cycleNumber}; previous lost count: ${lead.lostCycleCount}/${maxLostCycles}).`,
      lostReason: '',
      callbackAt: null,
      businessSnapshot: {
        businessProgramId: lead.businessProgramId || null,
        businessProgramName: lead.businessProgramName || '',
        businessProgramVariant: lead.businessProgramVariant || '',
        courseFees: lead.courseFees ?? null,
        paidAmount: lead.paidAmount ?? null,
      },
      updatedBy: actorInfo,
      timestamp: new Date(),
    })

    lead.notes.unshift({
      text: `Recycled by ${actorInfo.name} -> ${destinationText} (Cycle #${lead.cycleNumber})`,
      author: actorInfo.name,
      status: lead.status,
      subStatus: lead.subStatus,
      timestamp: new Date(),
    })

    await lead.save()

    if (assignedRep && assignedRep._id) {
      notifyTelegramEvent(
        'leadAssigned',
        {
          leadName: `${lead.fullName} (Recycled Cycle #${lead.cycleNumber})`,
          phone: lead.phone || 'N/A',
          course: lead.courseProgram || 'Not Specified',
          assignedBy: actorInfo.name || 'Administrator',
          count: '1',
        },
        { targetUserIds: [assignedRep._id.toString()] }
      )
    }

    res.status(200).json({
      success: true,
      message: `Lead "${lead.fullName}" recycled into ${destinationText} (Cycle #${lead.cycleNumber}).`,
      lead: sanitizeLeadForRole(lead, 'admin'),
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/bulk-recycle (Admin-only: Bulk or Entire-List recycle of LOST leads)
// Supports recycleMethod: 'pool' | 'specific' | 'round-robin', applyToAll, scope ('recyclable' | 'max_lost'), force
// -------------------------------------------------------------
export const bulkRecycleLeads = async (req, res) => {
  try {
    const {
      leadIds = [],
      recycleMethod,
      targetRepId,
      note,
      force = false,
      applyToAll = false,
      scope = 'recyclable',
    } = req.body || {}

    const settings = await getOrCreateCrmSettings()
    const maxLostCycles = settings.maxLostCycles || 3

    const query = { leadStatus: 'LOST' }
    if (applyToAll) {
      if (scope === 'max_lost') {
        query.lostCycleCount = { $gte: maxLostCycles }
      } else {
        query.lostCycleCount = { $lt: maxLostCycles }
      }
    } else {
      const validIds = (Array.isArray(leadIds) ? leadIds : []).filter(id =>
        mongoose.Types.ObjectId.isValid(id)
      )
      if (validIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Select at least one lead to recycle.' })
      }
      query._id = { $in: validIds }
      if (!force && scope !== 'max_lost') {
        query.lostCycleCount = { $lt: maxLostCycles }
      }
    }

    const method =
      recycleMethod ||
      (targetRepId && mongoose.Types.ObjectId.isValid(targetRepId) ? 'specific' : 'pool')

    const specificRep =
      method === 'specific' && targetRepId && mongoose.Types.ObjectId.isValid(targetRepId)
        ? await User.findById(targetRepId)
        : null

    if (method === 'specific' && !specificRep) {
      return res.status(400).json({ success: false, message: 'Please select a valid target counselor.' })
    }

    const leads = await Lead.find(query)
    if (leads.length === 0) {
      return res.status(200).json({
        success: true,
        recycledCount: 0,
        message: 'No matching LOST leads found to recycle.',
      })
    }

    const actorInfo = {
      userId: req.user?.id || '',
      name: req.user?.name || 'Admin',
      role: req.user?.role || 'admin',
    }

    let recycledCount = 0
    for (const lead of leads) {
      let chosenRep = specificRep
      if (method === 'round-robin') {
        const prevRepId = lead.lastLostBy?.repId || lead.assignedTo?.repId || null
        chosenRep = await pickRoundRobinCounselor(prevRepId)
      }

      lead.cycleNumber = (lead.cycleNumber || 1) + 1
      lead.leadStatus = 'NEW LEAD'
      lead.selectedCategory = ''
      lead.selectedCategoryLabel = ''
      lead.heatTier = null
      lead.status = 'Not Contacted'
      lead.canRecycle = false
      lead.isDropped = false
      lead.isCompleted = false
      lead.isCycleEnded = false
      lead.cycleEndReason = null

      // Preserve initialAdvisor before changing assignedTo on bulk recycle
      if (!lead.initialAdvisor?.repId) {
        if (lead.assignedTo?.repId) {
          lead.initialAdvisor = { ...lead.assignedTo }
        } else if (lead.lastLostBy?.repId) {
          lead.initialAdvisor = {
            repId: lead.lastLostBy.repId,
            repName: lead.lastLostBy.repName,
            repRole: 'Admissions Counselor',
            assignedAt: lead.lastLostBy.lostAt || lead.createdAt,
          }
        }
      }

      let destText = 'System Pool'
      if (chosenRep) {
        const nextAssigned = {
          repId: chosenRep._id,
          repName: chosenRep.name,
          repRole: chosenRep.title || 'Admissions Counselor',
          assignedAt: new Date(),
        }
        lead.assignmentStatus = 'ASSIGNED'
        lead.assignedTo = nextAssigned
        if (!lead.initialAdvisor?.repId) {
          lead.initialAdvisor = nextAssigned
        }
        lead.groupId = chosenRep.groupId || null
        lead.subStatus =
          method === 'round-robin'
            ? `Auto-Recycled (Round-Robin) to ${chosenRep.name} (Cycle #${lead.cycleNumber})`
            : `Recycled to ${chosenRep.name} (Cycle #${lead.cycleNumber})`
        destText = `${chosenRep.name}${method === 'round-robin' ? ' (Round-Robin)' : ''}`
      } else {
        lead.assignmentStatus = 'UNASSIGNED'
        lead.assignedTo = null
        lead.subStatus = `Recycled to System Pool (Cycle #${lead.cycleNumber})`
      }

      lead.steps = lead.steps || []
      lead.steps.push({
        stepNumber: lead.steps.length + 1,
        cycleNumber: lead.cycleNumber,
        previousStatus: 'LOST',
        newStatus: 'NEW LEAD',
        selectedCategory: 'admin_recycled',
        selectedCategoryLabel: `${force || scope === 'max_lost' ? 'Admin Override Recycle' : 'Bulk Recycled by Admin'} → ${destText} (Cycle #${lead.cycleNumber})`,
        heatTier: null,
        note: String(note || '').trim() || `Recycled by ${actorInfo.name} → ${destText} (Cycle #${lead.cycleNumber}).`,
        lostReason: '',
        callbackAt: null,
        businessSnapshot: {
          businessProgramId: lead.businessProgramId || null,
          businessProgramName: lead.businessProgramName || '',
          businessProgramVariant: lead.businessProgramVariant || '',
          courseFees: lead.courseFees ?? null,
          paidAmount: lead.paidAmount ?? null,
        },
        updatedBy: actorInfo,
        timestamp: new Date(),
      })

      await lead.save()
      recycledCount++
    }

    res.status(200).json({
      success: true,
      recycledCount,
      message: `Recycled ${recycledCount} LOST lead(s) (${method === 'round-robin' ? 'Auto Round-Robin' : method === 'specific' ? specificRep?.name : 'System Pool'}).`,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads (Manual lead typing / direct creation)
// -------------------------------------------------------------
export const createLead = async (req, res) => {
  try {
    const {
      fullName,
      name,
      phone,
      email,
      qualification,
      age,
      state,
      otherState,
      district,
      courseProgram,
      courseVariant,
      customerCategory,
      assignMode,
      assignedTo,
      groupId,
      formId,
      status,
      subStatus,
      author,
      referralData,
    } = req.body

    const nameVal = (fullName || name || '').trim()
    if (!nameVal) {
      return res.status(400).json({ success: false, message: 'Name is required' })
    }

    // Determine Assignment based on role:
    // - Sales advisor: strictly assigned to themselves (their own lead)
    // - Manager: can assign to themselves or members in their team
    // - Admin / Public: respects assignMode, specific counselor, or round-robin
    let leadAssignmentStatus = 'UNASSIGNED'
    let leadAssignedTo = null
    let leadGroupId = groupId || null

    const isCallerAdmin = req.user?.role === 'admin'
    const isCallerManager = Boolean(req.user?.isGroupManager) || req.user?.role === 'manager'
    const isCallerSales = Boolean(req.user) && !isCallerAdmin && !isCallerManager

    if (isCallerSales) {
      // Standard sales rep can strictly ONLY create leads assigned to themselves
      leadAssignmentStatus = 'ASSIGNED'
      leadAssignedTo = {
        repId: req.user._id || req.user.id,
        repName: req.user.name,
        repRole: req.user.title || 'Admissions Counselor',
        assignedAt: new Date(),
      }
      leadGroupId = req.user.groupId || null
    } else if (isCallerManager) {
      // Manager can assign to themselves OR a member in their team/group
      if (assignedTo && (assignedTo.repId || assignedTo.id)) {
        const repId = assignedTo.repId || assignedTo.id
        const counselor = await User.findById(repId)
        leadAssignmentStatus = 'ASSIGNED'
        leadAssignedTo = {
          repId: counselor ? counselor._id : repId,
          repName: counselor ? counselor.name : assignedTo.repName || 'Admissions Counselor',
          repRole: counselor ? (counselor.title || 'Admissions Counselor') : 'Admissions Counselor',
          assignedAt: new Date(),
        }
        leadGroupId = counselor?.groupId || req.user.groupId || groupId || null
      } else {
        // Defaults to manager themselves
        leadAssignmentStatus = 'ASSIGNED'
        leadAssignedTo = {
          repId: req.user._id || req.user.id,
          repName: req.user.name,
          repRole: req.user.title || 'Team Manager',
          assignedAt: new Date(),
        }
        leadGroupId = req.user.groupId || null
      }
    } else if (assignMode === 'pool') {
      leadAssignmentStatus = 'UNASSIGNED'
      leadAssignedTo = null
      leadGroupId = null
    } else if (assignedTo && (assignedTo.repId || assignedTo.id)) {
      const repId = assignedTo.repId || assignedTo.id
      const counselor = await User.findById(repId)
      leadAssignmentStatus = 'ASSIGNED'
      leadAssignedTo = {
        repId: counselor ? counselor._id : repId,
        repName: counselor ? counselor.name : assignedTo.repName || 'Admissions Counselor',
        repRole: counselor ? (counselor.title || 'Admissions Counselor') : 'Admissions Counselor',
        assignedAt: new Date(),
      }
      leadGroupId = counselor?.groupId || groupId || null
    } else {
      // Automatic capacity-aware round-robin assignment (falls back to System Pool if no eligible users exist)
      const allocation = await allocateLead(formId)
      leadAssignedTo = allocation.assignedTo || null
      leadAssignmentStatus = leadAssignedTo ? (allocation.assignmentStatus || 'ASSIGNED') : 'UNASSIGNED'
      leadGroupId = allocation.groupId || null
    }

    const cleanProgram = courseProgram || 'Healthcare Management'
    const cleanVariant = cleanProgram === 'Healthcare Management' ? (courseVariant || '') : ''

    const cleanState = String(state || '').trim()
    const cleanOtherState = cleanState === 'Other' ? String(otherState || '').trim() : ''
    const cleanDistrict = cleanState ? String(district || '').trim() : ''
    const resolvedLocation = cleanDistrict || cleanOtherState || cleanState || 'Not Specified'

    const newLead = new Lead({
      metaLeadId: `manual_${Date.now()}`,
      fullName: nameVal,
      phone: sanitizePhone(phone || ''),
      email: (email || '').toLowerCase().trim(),
      qualification: qualification || 'Degree',
      age: age ? Number(age) : null,
      state: cleanState,
      otherState: cleanOtherState,
      district: cleanDistrict,
      courseProgram: cleanProgram,
      courseVariant: cleanVariant,
      customerCategory: customerCategory || 'Ongoing Student',

      preferredLocation: resolvedLocation,
      learningMode: 'Flexible',
      careerRole: 'Hospital Administration',
      platform: 'Manual Entry',
      campaignName: 'Direct Admission / Manual Typing',
      adsetName: 'Inbound Enquiry',
      adName: 'Manual Entry',
      formName: 'Manual Admission Form',
      createdTime: new Date(),

      assignmentStatus: leadAssignmentStatus,
      assignedTo: leadAssignedTo,
      initialAdvisor: leadAssignedTo || null,
      groupId: leadGroupId,

      status: status || 'Not Contacted',
      subStatus: subStatus || (leadAssignmentStatus === 'ASSIGNED' ? 'Assigned to Counselor' : 'New Lead In Pool'),
      callAttempts: 0,
      callbackAt: null,
      isDropped: false,
      isCompleted: false,

      notes: [
        {
          text: leadAssignedTo
            ? `Lead manually added and assigned directly to ${leadAssignedTo.repName}`
            : 'Lead manually added to system pool',
          author: author || 'Admin',
          status: status || 'Not Contacted',
          subStatus: subStatus || (leadAssignmentStatus === 'ASSIGNED' ? 'Assigned to Counselor' : 'New Lead In Pool'),
          timestamp: new Date(),
        },
      ],
      referral: referralData && referralData.hasReferral
        ? {
            isReferred: true,
            referralType: referralData.referralType || referralData.referrerType || (referralData.isAlumni ? 'alumni' : 'student'),
            referrerName: referralData.referrerName || '',
            referrerPhone: referralData.referrerPhone || '',
            referrerCourse: referralData.referrerCourse || '',
            referrerBatch: referralData.referrerBatch || '',
          }
        : undefined,
    })

    const saved = await newLead.save()

    // When lead is saved with a referral, register student in Student DB (if LMS) and save Referral doc
    if (referralData && referralData.hasReferral) {
      try {
        const resolvedRefType = referralData.referralType || referralData.referrerType || (referralData.isAlumni ? 'alumni' : 'student')
        let linkedStudentId = referralData.referrerStudentId || null

        // If referrer is student or alumni, register them into the local CRM Student DB now (on save)
        if (resolvedRefType === 'student' || resolvedRefType === 'alumni') {
          const cleanRefPhone = sanitizePhone(referralData.referrerPhone)
          let student = null

          if (referralData.referrerStudentId && mongoose.Types.ObjectId.isValid(referralData.referrerStudentId)) {
            student = await Student.findById(referralData.referrerStudentId)
          }
          if (!student && referralData.lmsUserId) {
            student = await Student.findOne({ lmsUserId: referralData.lmsUserId })
          }
          if (!student && cleanRefPhone) {
            student = await Student.findOne({ phone: cleanRefPhone })
          }

          if (!student) {
            student = new Student({
              name: referralData.referrerName || 'LMS Student',
              phone: cleanRefPhone || referralData.referrerPhone || '',
              email: referralData.referrerEmail || '',
              course: referralData.referrerCourse || '',
              batch: referralData.referrerBatch || '',
              isAlumni: resolvedRefType === 'alumni',
              status: resolvedRefType === 'alumni' ? 'alumni' : 'active',
              studentId: referralData.referrerRollNo || '',
              lmsUserId: referralData.lmsUserId || '',
              isVerifiedLms: Boolean(referralData.isVerifiedLms ?? true),
            })
            await student.save()
          } else {
            let updated = false
            if (referralData.lmsUserId && !student.lmsUserId) { student.lmsUserId = referralData.lmsUserId; updated = true; }
            if (referralData.referrerCourse && !student.course) { student.course = referralData.referrerCourse; updated = true; }
            if (referralData.referrerBatch && !student.batch) { student.batch = referralData.referrerBatch; updated = true; }
            if (resolvedRefType === 'alumni' && !student.isAlumni) { student.isAlumni = true; student.status = 'alumni'; updated = true; }
            if (!student.isVerifiedLms && referralData.isVerifiedLms) { student.isVerifiedLms = true; updated = true; }
            if (updated) await student.save()
          }

          linkedStudentId = student._id
        }

        const refDoc = new Referral({
          referralType: resolvedRefType,
          referredLeadId: saved._id,
          referrerLeadId: resolvedRefType === 'lead' ? (referralData.referrerLeadId || null) : null,
          referrerStudentId: (resolvedRefType === 'student' || resolvedRefType === 'alumni') ? linkedStudentId : null,
          referrerName: referralData.referrerName || 'Referrer',
          referrerPhone: referralData.referrerPhone || '',
          referrerEmail: referralData.referrerEmail || '',
          referrerCourse: referralData.referrerCourse || '',
          referrerBatch: referralData.referrerBatch || '',
          isAlumni: resolvedRefType === 'alumni',
          referredCandidateName: saved.fullName,
          referredCandidatePhone: saved.phone,
          referredCandidateCourse: saved.courseProgram,
          leadStatus: saved.leadStatus || 'NEW LEAD',
          courseFees: 0,
          paidAmount: 0,
          assignedCounselor: saved.assignedTo
            ? { repId: saved.assignedTo.repId, repName: saved.assignedTo.repName }
            : null,
        })
        const savedRef = await refDoc.save()
        saved.referral.referralId = savedRef._id
        saved.referral.referralType = resolvedRefType
        await saved.save()
      } catch (refErr) {
        console.error('[createLead] Error saving referral link:', refErr)
      }
    }

    // Dispatch Telegram notifications for newly created lead
    notifyTelegramEvent(
      'newLead',
      {
        leadName: saved.fullName || 'New Lead',
        phone: saved.phone || 'N/A',
        course: saved.courseProgram || 'Not Specified',
        source: saved.platform || 'Manual Entry',
        assignedTo: saved.assignedTo?.repName || 'System Pool (Unassigned)',
      },
      { notifyAdmins: true }
    )
    if (
      saved.assignedTo?.repId &&
      String(saved.assignedTo.repId) !== String(req.user?.id || req.user?._id || '')
    ) {
      notifyTelegramEvent(
        'leadAssigned',
        {
          leadName: saved.fullName || 'New Lead',
          phone: saved.phone || 'N/A',
          course: saved.courseProgram || 'Not Specified',
          assignedBy: req.user?.name || author || 'Admin',
          count: '1',
        },
        { targetUserIds: [saved.assignedTo.repId.toString()] }
      )
    }

    res.status(201).json({
      success: true,
      message: `Lead for ${saved.fullName} created successfully`,
      lead: { ...saved.toObject(), id: saved._id.toString() },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PUT /api/leads/:id/profile (Admin or Counselor Edit Profile)
// -------------------------------------------------------------
export const updateLeadProfile = async (req, res) => {
  try {
    const { id } = req.params
    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Student / Lead not found' })
    }

    // Permission check: Admin or Assigned Sales Counselor only
    const actor = req.user
    if (actor && actor.role !== 'admin' && !isLeadAssignedToUser(lead, actor)) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit profiles and statuses for leads assigned to you.',
      })
    }

    const {
      fullName,
      phone,
      email,
      qualification,
      age,
      state,
      otherState,
      district,
      courseProgram,
      courseVariant,
      customerCategory,
      categoryKey,
      leadStatus,
      status,
      subStatus,
      isDropped,
      droppedReason,
      lostReason,
      isCompleted,
      businessProgramId,
      businessProgramName,
      businessProgramVariant,
      courseFees,
      paidAmount,
      adminException,
      stepNote,
      callbackAt,
      assignmentStatus,
      assignedTo,
      author,
    } = req.body

    // Quick Mark Completed / Mark Dropped via profile update is Admin-only
    if (actor && actor.role !== 'admin' && (isCompleted !== undefined || isDropped !== undefined)) {
      return res.status(403).json({
        success: false,
        message: 'Quick Mark Completed / Mark Dropped is restricted to Administrators only.',
      })
    }

    if (fullName) lead.fullName = fullName.trim()
    if (phone !== undefined) lead.phone = sanitizePhone(phone)
    if (email !== undefined) lead.email = (email || '').toLowerCase().trim()
    if (qualification) lead.qualification = qualification
    if (age !== undefined) lead.age = age ? Number(age) : null
    if (state !== undefined) lead.state = String(state || '').trim()
    if (otherState !== undefined) lead.otherState = String(otherState || '').trim()
    if (district !== undefined) lead.district = String(district || '').trim()

    // Keep preferredLocation synchronized whenever geography/demography is updated
    if (state !== undefined || otherState !== undefined || district !== undefined) {
      const effectiveDistrict = lead.district ? lead.district.trim() : ''
      const effectiveOtherState = lead.state === 'Other' ? (lead.otherState || '').trim() : ''
      const effectiveState = (lead.state || '').trim()
      const computedLoc =
        effectiveDistrict ||
        effectiveOtherState ||
        (effectiveState && effectiveState !== 'Other' ? effectiveState : '')
      if (computedLoc) {
        lead.preferredLocation = computedLoc
      } else if (!lead.preferredLocation || lead.preferredLocation === 'Not Specified') {
        lead.preferredLocation = 'Not Specified'
      }
    }
    if (courseProgram) {
      lead.courseProgram = courseProgram
      if (courseProgram !== 'Healthcare Management') {
        lead.courseVariant = ''
      } else if (courseVariant !== undefined) {
        lead.courseVariant = courseVariant
      }
    } else if (courseVariant !== undefined && lead.courseProgram === 'Healthcare Management') {
      lead.courseVariant = courseVariant
    }
    if (customerCategory) lead.customerCategory = customerCategory

    // Apply lifecycle / business fields update if any lifecycle or financial field was passed
    const hasLifecycleUpdate =
      categoryKey !== undefined ||
      leadStatus !== undefined ||
      lostReason !== undefined ||
      businessProgramId !== undefined ||
      businessProgramName !== undefined ||
      courseFees !== undefined ||
      paidAmount !== undefined ||
      status !== undefined ||
      subStatus !== undefined ||
      isCompleted !== undefined ||
      isDropped !== undefined

    if (hasLifecycleUpdate) {
      const settings = await getOrCreateCrmSettings()
      const result = await applyLifecycleUpdate(
        lead,
        {
          categoryKey,
          leadStatus,
          status,
          subStatus,
          note: stepNote || `Profile & lifecycle updated (${lead.fullName})`,
          callbackAt,
          lostReason: lostReason ?? droppedReason,
          businessProgramId,
          businessProgramName,
          businessProgramVariant,
          courseFees,
          paidAmount,
          adminException,
          author,
          isCompleted,
          isDropped,
          droppedReason,
        },
        actor,
        settings
      )
      if (result.error) {
        return res.status(result.statusCode || 400).json({
          success: false,
          message: result.error,
        })
      }
    }

    // Assignment updates (Admin only can reassign or return to pool)
    if (!actor || actor.role === 'admin') {
      if (assignmentStatus === 'UNASSIGNED') {
        if (!lead.initialAdvisor?.repId && lead.assignedTo?.repId) {
          lead.initialAdvisor = { ...lead.assignedTo }
        }
        lead.assignmentStatus = 'UNASSIGNED'
        lead.assignedTo = null
      } else if (assignedTo && (assignedTo.repId || assignedTo.id)) {
        if (!lead.initialAdvisor?.repId && lead.assignedTo?.repId) {
          lead.initialAdvisor = { ...lead.assignedTo }
        }
        const repId = assignedTo.repId || assignedTo.id
        const counselor = await User.findById(repId)
        const nextAssigned = {
          repId: counselor ? counselor._id : repId,
          repName: counselor ? counselor.name : assignedTo.repName,
          repRole: counselor ? (counselor.title || 'Admissions Counselor') : 'Admissions Counselor',
          assignedAt: new Date(),
        }
        lead.assignmentStatus = 'ASSIGNED'
        lead.assignedTo = nextAssigned
        if (!lead.initialAdvisor?.repId) {
          lead.initialAdvisor = nextAssigned
        }
        lead.groupId = counselor?.groupId || lead.groupId
      }
    }

    if (!hasLifecycleUpdate) {
      lead.notes.unshift({
        text: `Student profile updated: ${lead.fullName} (${lead.courseProgram}${lead.courseVariant ? ' - ' + lead.courseVariant : ''})`,
        author: actor?.name || author || 'Counselor',
        status: lead.status,
        subStatus: lead.subStatus,
        timestamp: new Date(),
      })
    }

    await lead.save()

    res.status(200).json({
      success: true,
      message: 'Student profile updated successfully',
      lead: sanitizeLeadForRole(lead, actor?.role || 'sales'),
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// DELETE /api/leads/:id
// -------------------------------------------------------------
export const deleteLead = async (req, res) => {
  try {
    const { id } = req.params
    const deleted = await Lead.findByIdAndDelete(id)
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    res.status(200).json({ success: true, message: 'Lead deleted successfully' })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/bulk-delete (Remove multiple leads by _id, metaLeadId, or entire scope)
// -------------------------------------------------------------
export const bulkDeleteLeads = async (req, res) => {
  try {
    const { leadIds = [], metaLeadIds = [], applyToAll = false, scope, filters = {} } = req.body || {}

    if (applyToAll && scope) {
      const settings = await getOrCreateCrmSettings()
      const maxLostCycles = settings.maxLostCycles || 3
      let scopeFilter = null
      let scopeLabel = 'list'

      if (scope === 'max_lost') {
        scopeFilter = { leadStatus: 'LOST', lostCycleCount: { $gte: maxLostCycles } }
        scopeLabel = 'Max-Limit Lost list'
      } else if (scope === 'recyclable') {
        scopeFilter = { leadStatus: 'LOST', lostCycleCount: { $lt: maxLostCycles } }
        scopeLabel = 'Recyclable Lost list'
      } else if (scope === 'pool') {
        const searchCond = buildLeadSearchCondition(filters?.search)
        scopeFilter = searchCond
          ? { $and: [{ assignmentStatus: 'UNASSIGNED' }, searchCond] }
          : { assignmentStatus: 'UNASSIGNED' }
        scopeLabel = 'System Pool'
      } else if (scope === 'master') {
        const andConditions = [{ assignmentStatus: 'ASSIGNED' }]
        const { status, qualification, search } = filters || {}
        if (status && status !== 'All') {
          if (['HOT', 'WARM', 'COLD'].includes(status)) {
            andConditions.push({ $or: [{ leadStatus: status }, { heatTier: status }] })
          } else if (status === 'NEW LEAD') {
            andConditions.push({
              $or: [{ leadStatus: 'NEW LEAD' }, { leadStatus: { $exists: false } }, { leadStatus: null }],
            })
          } else if (LEAD_STATUSES.includes(status)) {
            andConditions.push({ leadStatus: status })
          } else {
            andConditions.push({ status })
          }
        }
        if (qualification && qualification !== 'All') {
          andConditions.push({ qualification: new RegExp(escapeRegex(qualification), 'i') })
        }
        const searchCond = buildLeadSearchCondition(search)
        if (searchCond) {
          andConditions.push(searchCond)
        }
        scopeFilter = andConditions.length === 1 ? andConditions[0] : { $and: andConditions }
        scopeLabel = 'Master Leads list'
      }

      if (!scopeFilter) {
        return res.status(400).json({ success: false, message: `Unsupported bulk-delete scope: "${scope}"` })
      }
      const result = await Lead.deleteMany(scopeFilter)
      return res.status(200).json({
        success: true,
        deletedCount: result.deletedCount,
        message: `Removed all ${result.deletedCount} lead(s) from ${scopeLabel}.`,
      })
    }

    const validObjectIds = (Array.isArray(leadIds) ? leadIds : [])
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id))

    const cleanMetaIds = (Array.isArray(metaLeadIds) ? metaLeadIds : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)

    const orConditions = []
    if (validObjectIds.length > 0) {
      orConditions.push({ _id: { $in: validObjectIds } })
    }
    if (cleanMetaIds.length > 0) {
      orConditions.push({ metaLeadId: { $in: cleanMetaIds } })
    }

    if (orConditions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one valid leadId or metaLeadId to delete.',
      })
    }

    const result = await Lead.deleteMany({ $or: orConditions })
    res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: `Removed ${result.deletedCount} lead(s) from database.`,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/leads/reset-db (Clean lead database - reseeding disabled)
// -------------------------------------------------------------
export const resetLeadDatabase = async (req, res) => {
  try {
    const { mode } = req.body

    if (mode && mode !== 'clean') {
      return res.status(400).json({
        success: false,
        message: 'Test/demo data reseeding is disabled.',
      })
    }

    const now = new Date()
    const deleteResult = await Lead.deleteMany({})
    await MetaIntegration.updateMany({}, {
      $set: {
        lastSuccessfulSyncAt: now,
        lastSyncMessage: 'Database cleaned: All leads wiped. Historical sync disabled to prevent resurrecting old submissions.',
      },
    })
    return res.status(200).json({
      success: true,
      message: `Database cleaned: Deleted ${deleteResult.deletedCount} leads. The database is now empty.`,
      deletedCount: deleteResult.deletedCount,
      leadsCount: 0,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
