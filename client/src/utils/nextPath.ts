const DEFAULT_NEXT_PATH = '/game'
const NEXT_PATH_STORAGE_KEY = 'gather_auth_next_path'

export function sanitizeNextPath(nextPath: string | null | undefined, fallback = DEFAULT_NEXT_PATH) {
  const value = typeof nextPath === 'string' ? nextPath.trim() : ''
  if (!value) return fallback
  if (!value.startsWith('/')) return fallback
  // Block protocol-relative URLs and backslash variants that some user agents normalize to //
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback
  return value
}

export function readNextPathFromSearch(search: string, fallback = DEFAULT_NEXT_PATH) {
  const params = new URLSearchParams(search)
  return sanitizeNextPath(params.get('next'), fallback)
}

export function buildPathWithNext(basePath: string, nextPath: string | null | undefined) {
  const safeNextPath = sanitizeNextPath(nextPath, '')
  if (!safeNextPath) return basePath

  const params = new URLSearchParams()
  params.set('next', safeNextPath)
  return `${basePath}?${params.toString()}`
}

export function savePendingNextPath(nextPath: string | null | undefined) {
  const safeNextPath = sanitizeNextPath(nextPath, '')
  if (!safeNextPath) return
  try {
    window.localStorage.setItem(NEXT_PATH_STORAGE_KEY, safeNextPath)
  } catch {
    // ignore storage failures
  }
}

export function readPendingNextPath(fallback = DEFAULT_NEXT_PATH) {
  try {
    const stored = window.localStorage.getItem(NEXT_PATH_STORAGE_KEY)
    return sanitizeNextPath(stored, fallback)
  } catch {
    return fallback
  }
}

export function clearPendingNextPath() {
  try {
    window.localStorage.removeItem(NEXT_PATH_STORAGE_KEY)
  } catch {
    // ignore storage failures
  }
}
