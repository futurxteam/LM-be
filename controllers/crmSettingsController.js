import CourseProgram, { ensureDefaultPrograms } from '../models/CourseProgram.js'
import { getOrCreateCrmSettings, LEAD_STATUSES, deriveHeatTierFromStatus } from '../models/CrmSettings.js'

// -------------------------------------------------------------
// GET /api/crm/meta - Shared lifecycle options for Admin & Sales
// (Strips heatTier for non-admin users so Sales never sees Hot/Warm/Cold)
// -------------------------------------------------------------
export const getCrmMeta = async (req, res) => {
  try {
    const [settings, programs] = await Promise.all([
      getOrCreateCrmSettings(),
      ensureDefaultPrograms(),
    ])

    const isAdmin = req.user?.role === 'admin'
    const activeCategories = (settings.outcomeCategories || []).filter(c => c.active !== false)

    const sanitizedCategories = activeCategories.map(cat => ({
      key: cat.key,
      label: cat.label,
      leadStatus: cat.leadStatus,
      group: isAdmin
        ? cat.group
        : String(cat.group || 'General').replace(/\s*\((End of Cycle|Recyclable)\)/gi, '').trim(),
      ...(isAdmin ? { heatTier: cat.heatTier || deriveHeatTierFromStatus(cat.leadStatus) } : {}),
    }))

    res.status(200).json({
      success: true,
      programs: programs.filter(p => p.active !== false),
      allPrograms: isAdmin ? programs : undefined,
      outcomeCategories: sanitizedCategories,
      lostReasons: settings.lostReasons || [],
      leadStatuses: LEAD_STATUSES,
      policy: {
        requireBusinessFields: settings.requireBusinessFields,
        allowSalesFinancialEdit: settings.allowSalesFinancialEdit,
        ...(isAdmin
          ? {
              maxLostCycles: settings.maxLostCycles,
              lostRecycleMode: settings.lostRecycleMode,
              allowAdminBusinessFieldException: settings.allowAdminBusinessFieldException,
            }
          : {}),
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/crm/settings - Admin-only full settings
// -------------------------------------------------------------
export const getCrmSettings = async (req, res) => {
  try {
    const [settings, programs] = await Promise.all([
      getOrCreateCrmSettings(),
      ensureDefaultPrograms(),
    ])
    res.status(200).json({
      success: true,
      settings,
      programs,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PUT /api/crm/settings - Admin-only update CRM lifecycle & recycle policy
// -------------------------------------------------------------
export const updateCrmSettings = async (req, res) => {
  try {
    const settings = await getOrCreateCrmSettings()
    const {
      maxLostCycles,
      lostRecycleMode,
      requireBusinessFields,
      allowAdminBusinessFieldException,
      allowSalesFinancialEdit,
      outcomeCategories,
      lostReasons,
    } = req.body || {}

    if (maxLostCycles !== undefined) {
      const parsed = Number(maxLostCycles)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
        return res.status(400).json({
          success: false,
          message: 'maxLostCycles must be an integer between 1 and 20.',
        })
      }
      settings.maxLostCycles = parsed
    }

    if (lostRecycleMode !== undefined) {
      if (!['manual', 'auto_pool'].includes(lostRecycleMode)) {
        return res.status(400).json({
          success: false,
          message: 'lostRecycleMode must be "manual" or "auto_pool".',
        })
      }
      settings.lostRecycleMode = lostRecycleMode
    }

    if (requireBusinessFields !== undefined) {
      settings.requireBusinessFields = Boolean(requireBusinessFields)
    }
    if (allowAdminBusinessFieldException !== undefined) {
      settings.allowAdminBusinessFieldException = Boolean(allowAdminBusinessFieldException)
    }
    if (allowSalesFinancialEdit !== undefined) {
      settings.allowSalesFinancialEdit = Boolean(allowSalesFinancialEdit)
    }

    if (Array.isArray(outcomeCategories) && outcomeCategories.length > 0) {
      settings.outcomeCategories = outcomeCategories
        .filter(c => c && c.key && c.label && LEAD_STATUSES.includes(c.leadStatus))
        .map(c => ({
          key: String(c.key).trim(),
          label: String(c.label).trim(),
          leadStatus: c.leadStatus,
          heatTier: c.heatTier || deriveHeatTierFromStatus(c.leadStatus),
          group: c.group || 'General',
          active: c.active !== false,
        }))
    }

    if (Array.isArray(lostReasons) && lostReasons.length > 0) {
      settings.lostReasons = lostReasons.map(r => String(r || '').trim()).filter(Boolean)
    }

    await settings.save()
    res.status(200).json({
      success: true,
      message: 'CRM lifecycle & recycle settings updated successfully.',
      settings,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// GET /api/crm/programs - List approved Course Programs
// -------------------------------------------------------------
export const getCoursePrograms = async (req, res) => {
  try {
    const programs = await ensureDefaultPrograms()
    res.status(200).json({ success: true, programs })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// POST /api/crm/programs - Admin create Course Program
// -------------------------------------------------------------
export const createCourseProgram = async (req, res) => {
  try {
    const { name, code, variants, defaultFee, active } = req.body || {}
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Program name is required.' })
    }

    const cleanName = String(name).trim()
    const existing = await CourseProgram.findOne({ name: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
    if (existing) {
      return res.status(400).json({ success: false, message: 'A program with this name already exists.' })
    }

    const cleanVariants = Array.isArray(variants)
      ? variants.map(v => String(v || '').trim()).filter(Boolean)
      : typeof variants === 'string'
      ? variants.split(',').map(v => v.trim()).filter(Boolean)
      : []

    const program = await CourseProgram.create({
      name: cleanName,
      code: String(code || '').trim().toUpperCase(),
      variants: cleanVariants,
      defaultFee: Number(defaultFee) >= 0 ? Number(defaultFee) : 0,
      active: active !== false,
    })

    res.status(201).json({
      success: true,
      message: `Course program "${program.name}" created.`,
      program,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// PUT /api/crm/programs/:id - Admin update Course Program
// -------------------------------------------------------------
export const updateCourseProgram = async (req, res) => {
  try {
    const { id } = req.params
    const program = await CourseProgram.findById(id)
    if (!program) {
      return res.status(404).json({ success: false, message: 'Course program not found.' })
    }

    const { name, code, variants, defaultFee, active } = req.body || {}
    if (name !== undefined && String(name).trim()) program.name = String(name).trim()
    if (code !== undefined) program.code = String(code).trim().toUpperCase()
    if (variants !== undefined) {
      program.variants = Array.isArray(variants)
        ? variants.map(v => String(v || '').trim()).filter(Boolean)
        : typeof variants === 'string'
        ? variants.split(',').map(v => v.trim()).filter(Boolean)
        : []
    }
    if (defaultFee !== undefined) {
      program.defaultFee = Number(defaultFee) >= 0 ? Number(defaultFee) : 0
    }
    if (active !== undefined) program.active = Boolean(active)

    await program.save()
    res.status(200).json({
      success: true,
      message: `Course program "${program.name}" updated.`,
      program,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// -------------------------------------------------------------
// DELETE /api/crm/programs/:id - Admin delete Course Program
// -------------------------------------------------------------
export const deleteCourseProgram = async (req, res) => {
  try {
    const { id } = req.params
    const deleted = await CourseProgram.findByIdAndDelete(id)
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Course program not found.' })
    }
    res.status(200).json({
      success: true,
      message: `Course program "${deleted.name}" removed.`,
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}
