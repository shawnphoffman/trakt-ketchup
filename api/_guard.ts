import type { VercelRequest } from '@vercel/node'

// Shared request guards for the serverless functions. Files prefixed with `_`
// are not routed by Vercel, so this is a plain module rather than an endpoint.

/**
 * Origins allowed to call our functions. Derived from the app's own redirect
 * URI, plus an optional ALLOWED_ORIGINS override (comma-separated) and
 * localhost for dev. Locking this down stops third parties from burning our
 * credentials, rate limit, and function quota.
 */
export function allowedOrigins(): Set<string> {
  const origins = new Set<string>(['http://localhost:3000', 'http://127.0.0.1:3000'])
  const redirect = process.env.VITE_TRAKT_REDIRECT_URI
  if (redirect) {
    try {
      origins.add(new URL(redirect).origin)
    } catch {
      // ignore an unparseable redirect URI
    }
  }
  for (const o of (process.env.ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = o.trim()
    if (trimmed) origins.add(trimmed)
  }
  return origins
}

export function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first || (req.headers['x-real-ip'] as string) || 'unknown'
}

/**
 * Best-effort per-IP rate limit: an in-memory fixed window that only covers a
 * single warm function instance (Vercel may run several), so it's a speed bump
 * against abuse, not a hard guarantee.
 *
 * Each endpoint gets its own bucket so a chatty one can't exhaust a quiet one's
 * budget.
 */
const RATE_WINDOW_MS = 60_000
const buckets = new Map<string, Map<string, { count: number; resetAt: number }>>()

/** Returns true if the caller is over `limit` for the current window. */
export function rateLimited(bucket: string, ip: string, limit: number): boolean {
  let hits = buckets.get(bucket)
  if (!hits) {
    hits = new Map()
    buckets.set(bucket, hits)
  }

  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || now >= entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    // Opportunistically drop expired entries so the map can't grow unbounded.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k)
    }
    return false
  }
  entry.count += 1
  return entry.count > limit
}
