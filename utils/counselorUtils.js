/**
 * Checks whether an admissions counselor / sales rep is currently paused
 * from receiving leads via round-robin (Meta webhook, pool auto-assign, or recycling).
 *
 * Automatically resumes counselors once their pauseEndDate has passed.
 */
export function isCounselorPaused(counselor, atDate = new Date()) {
  if (!counselor) return false
  if (!counselor.isPaused) return false

  const now = new Date(atDate).getTime()

  // Both start and end dates specified
  if (counselor.pauseStartDate && counselor.pauseEndDate) {
    const start = new Date(counselor.pauseStartDate).setHours(0, 0, 0, 0)
    const end = new Date(counselor.pauseEndDate).setHours(23, 59, 59, 999)
    // If within pause window
    if (now >= start && now <= end) {
      return true
    }
    // If pause window has passed, automatically resume
    return false
  }

  // Only start date specified (e.g. pause starting today or future)
  if (counselor.pauseStartDate && !counselor.pauseEndDate) {
    const start = new Date(counselor.pauseStartDate).setHours(0, 0, 0, 0)
    return now >= start
  }

  // Indefinite manual pause
  return true
}

/**
 * Checks whether a counselor was paused at a specific historical timestamp
 * (checks both current pause window and pauseHistory records).
 */
export function wasCounselorPausedAt(counselor, atDate) {
  if (!counselor || !atDate) return false
  const ts = new Date(atDate).getTime()
  if (Number.isNaN(ts)) return false

  if (isCounselorPaused(counselor, atDate)) return true

  if (Array.isArray(counselor.pauseHistory) && counselor.pauseHistory.length > 0) {
    for (const h of counselor.pauseHistory) {
      const start = h.startDate
        ? new Date(h.startDate).setHours(0, 0, 0, 0)
        : h.pausedAt
        ? new Date(h.pausedAt).getTime()
        : null
      const end = h.endDate
        ? new Date(h.endDate).setHours(23, 59, 59, 999)
        : h.resumedAt
        ? new Date(h.resumedAt).getTime()
        : null
      if (start !== null && ts >= start && (end === null || ts <= end)) {
        return true
      }
    }
  }
  return false
}

