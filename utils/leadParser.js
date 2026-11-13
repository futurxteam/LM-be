import XLSX from 'xlsx'

/**
 * Clean and normalize phone numbers
 * e.g., "p:+919947001074" -> "+919947001074"
 *       "p:8113843453"      -> "+918113843453"
 *       "p:+971566014305"   -> "+971566014305"
 */
export function sanitizePhone(raw) {
  if (!raw) return ''
  let cleaned = String(raw).trim()
  if (cleaned.startsWith('p:')) {
    cleaned = cleaned.substring(2).trim()
  }
  // Remove spaces, dashes, brackets
  cleaned = cleaned.replace(/[\s\-\(\)]/g, '')

  // If 10 digits without country code, assume India (+91)
  if (/^\d{10}$/.test(cleaned)) {
    cleaned = `+91${cleaned}`
  } else if (!cleaned.startsWith('+') && /^\d+$/.test(cleaned)) {
    cleaned = `+${cleaned}`
  }
  return cleaned
}

/**
 * Format qualification string
 */
export function formatQualification(val) {
  if (!val) return 'Not Specified'
  const str = String(val).trim().toLowerCase()
  if (str.includes('postgraduation') || str.includes('post_graduation') || str.includes('pg') || str.includes('masters')) {
    return 'Post Graduation'
  }
  if (str.includes('graduation') || str.includes('degree') || str.includes('bachelors')) {
    return 'Graduation / Degree'
  }
  if (str.includes('plus_two') || str.includes('+2') || str.includes('12th')) {
    return 'Higher Secondary (+2)'
  }
  if (str.includes('diploma')) {
    return 'Diploma'
  }
  return String(val).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Normalize platform name
 */
export function formatPlatform(val) {
  if (!val) return 'Meta Ads'
  const str = String(val).trim().toLowerCase()
  if (str === 'ig' || str === 'instagram') return 'Instagram'
  if (str === 'fb' || str === 'facebook') return 'Facebook'
  return String(val)
}

/**
 * Intelligent extraction from a row object produced by XLSX/CSV
 */
export function extractLeadFromRow(row, index = 0) {
  const keys = Object.keys(row)
  
  // Check if this row is accidentally a repeated header row
  const firstVal = String(row[keys[0]] || '').trim().toLowerCase()
  if (firstVal === 'id' || firstVal === 'created_time' || firstVal.includes('platform')) {
    return null
  }

  let metaLeadId = ''
  let fullName = ''
  let phone = ''
  let email = ''
  let qualification = ''
  let preferredLocation = ''
  let learningMode = ''
  let interestReason = ''
  let careerRole = ''
  let campaignName = ''
  let adsetName = ''
  let adName = ''
  let formName = ''
  let platform = 'Meta'
  let createdTime = new Date().toISOString()
  const customFields = {}

  for (const rawKey of keys) {
    const key = rawKey.trim()
    const lowerKey = key.toLowerCase()
    const val = row[rawKey] != null ? String(row[rawKey]).trim() : ''

    if (!val || val === '########') continue

    // Meta ID
    if (lowerKey === 'id' || lowerKey === 'lead_id') {
      metaLeadId = val.startsWith('l:') ? val.substring(2) : val
    }
    // Full Name
    else if (lowerKey === 'full_name' || lowerKey === 'name' || lowerKey === 'fullname' || lowerKey === 'contact_name') {
      fullName = val
    }
    // Phone
    else if (lowerKey.includes('phone') || lowerKey === 'mobile' || lowerKey === 'contact_no') {
      phone = sanitizePhone(val)
    }
    // Email
    else if (lowerKey.includes('email') || lowerKey === 'mail') {
      email = val.toLowerCase()
    }
    // Qualification / Highest Education
    else if (lowerKey.includes('qualification') || lowerKey.includes('educational') || lowerKey.includes('education') || lowerKey.includes('degree')) {
      qualification = formatQualification(val)
    }
    // Preferred City / Work Location (handles Malayalam question too)
    else if (
      key.includes('കോഴ്സ്_പൂർത്തിയാക്കിയ') ||
      key.includes('സിറ്റിയിൽ') ||
      lowerKey.includes('city') ||
      lowerKey.includes('location') ||
      lowerKey.includes('place')
    ) {
      preferredLocation = val.replace(/_/g, ' ')
    }
    // Learning Mode
    else if (lowerKey.includes('learning_mode') || lowerKey.includes('learning mode') || lowerKey.includes('mode_do_you_prefer')) {
      learningMode = val.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }
    // Career Role / Reason for interest
    else if (lowerKey.includes('why_are_you_interested') || lowerKey.includes('interested_in')) {
      interestReason = val.replace(/_/g, ' ')
    } else if (lowerKey.includes('career_role') || lowerKey.includes('role_interests')) {
      careerRole = val.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }
    // Campaign details
    else if (lowerKey === 'campaign_name' || lowerKey.includes('campaign_name')) {
      campaignName = val
    } else if (lowerKey === 'adset_name' || lowerKey.includes('adset_name')) {
      adsetName = val
    } else if (lowerKey === 'ad_name' || lowerKey.includes('ad_name')) {
      adName = val
    } else if (lowerKey === 'form_name' || lowerKey.includes('form_name')) {
      formName = val
    } else if (lowerKey === 'platform') {
      platform = formatPlatform(val)
    } else if (lowerKey === 'created_time') {
      createdTime = val
    } else {
      customFields[key] = val
    }
  }

  // Fallback defaults
  if (!fullName) fullName = email.split('@')[0] || `Lead-${index + 1}`
  if (!metaLeadId) metaLeadId = `gen_${Date.now()}_${index}`
  if (!campaignName) campaignName = 'Healthcare Management Meta Campaign'
  if (!formName) formName = 'Healthcare Management Lead Form'

  return {
    id: Date.now() + index,
    metaLeadId,
    fullName,
    phone,
    email,
    qualification: qualification || 'Graduation / Degree',
    preferredLocation: preferredLocation || 'Not Specified',
    learningMode: learningMode || 'Flexible',
    interestReason: interestReason || '',
    careerRole: careerRole || 'Hospital Administration',
    platform,
    campaignName,
    adsetName: adsetName || campaignName,
    adName: adName || 'Testimonial Ad',
    formName,
    createdTime,
    customFields,
    
    // Assignment fields
    assignmentStatus: 'UNASSIGNED', // 'UNASSIGNED' | 'ASSIGNED'
    assignedTo: null, // { repId, repName, assignedAt }
    
    // Contact & Pipeline status
    status: 'Not Contacted', // 'Not Contacted' | 'Contacted'
    subStatus: 'New Lead In Pool', // 'Ringing', 'Busy', 'Callback Scheduled', 'Interested', 'Follow-up', 'Enrolled', etc.
    callAttempts: 0,
    callbackAt: null,
    notes: [
      {
        text: `Ingested from ${platform} Lead Ad form: "${formName}"`,
        author: 'System Ingestion',
        timestamp: new Date().toISOString(),
      }
    ],
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Parses XLSX buffer or CSV/TSV string and extracts leads
 */
export function parseLeadsData(input, isBuffer = false) {
  let workbook
  if (isBuffer) {
    workbook = XLSX.read(input, { type: 'buffer' })
  } else {
    workbook = XLSX.read(input, { type: 'string' })
  }

  const leads = []
  let duplicateCount = 0

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

    rawRows.forEach((row, idx) => {
      const parsed = extractLeadFromRow(row, idx)
      if (parsed && (parsed.phone || parsed.email || parsed.fullName)) {
        leads.push(parsed)
      }
    })
  }

  return leads
}

