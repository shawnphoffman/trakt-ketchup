import { promises as dns } from 'node:dns'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// Read-only passthrough to the user's own Plex Media Server.
//
// This exists because PMS does not allow cross-origin reads from arbitrary
// sites: it answers preflights with a fixed `Access-Control-Allow-Origin:
// https://app.plex.tv`, so a browser-direct call from this app is blocked no
// matter what we send. Server-to-server has no such restriction. plex.tv's own
// account API *does* allow us, so only PMS traffic comes through here.
//
// GET /api/plex/proxy?url=<absolute https URL on *.plex.direct>
//   X-Plex-Token and the other X-Plex-* client headers are forwarded as sent.
//
// Nothing is stored, logged, or inspected: the body is streamed back to the
// caller as-is and the token lives only for the duration of the request.

// NOTE: everything this function needs is defined in this file, deliberately.
// Vercel does not ship a shared module under api/ into the function bundle, so
// an import of a sibling helper resolves fine under `vercel dev` (which reads
// the local filesystem) and then dies with ERR_MODULE_NOT_FOUND in production.
// The small duplication with api/oauth/token.ts is the price of that.

const RATE_LIMIT = 240 // requests per minute, per IP
const RATE_WINDOW_MS = 60_000

/** A full library scan pages through in chunks, so allow a generous window. */
const UPSTREAM_TIMEOUT_MS = 15_000

/** Only these are passed upstream; anything else the browser sent is dropped. */
const FORWARDED_HEADERS = [
  'accept',
  'x-plex-token',
  'x-plex-client-identifier',
  'x-plex-product',
  'x-plex-version',
  'x-plex-platform',
]

const hits = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first || (req.headers['x-real-ip'] as string) || 'unknown'
}

/**
 * Best-effort per-IP rate limit: an in-memory fixed window covering a single
 * warm instance, so a speed bump against abuse rather than a guarantee. The cap
 * is high because a full library scan legitimately pages through many requests.
 */
function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || now >= entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k)
    }
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  // Same-origin GETs carry no Origin header, so the allowlist check used by the
  // OAuth proxy can't apply here. Sec-Fetch-Site is the equivalent signal: every
  // current browser sends it, and a cross-site page cannot forge it. Absent
  // (older browser, or a non-browser client) is allowed through to the rate
  // limiter rather than blocked outright.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: 'forbidden_origin' })
    return
  }

  if (rateLimited(clientIp(req))) {
    res.status(429).json({ error: 'rate_limited' })
    return
  }

  const raw = req.query.url
  const target = Array.isArray(raw) ? raw[0] : raw
  if (!target) {
    res.status(400).json({ error: 'missing_url' })
    return
  }

  let url: URL
  try {
    url = new URL(target)
  } catch {
    res.status(400).json({ error: 'invalid_url' })
    return
  }

  // The only hosts this proxy will ever touch. plex.direct hostnames carry a
  // real certificate for whatever address the user's server advertised, which
  // is exactly (and only) what we want to reach.
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.plex.direct')) {
    res.status(400).json({ error: 'forbidden_target' })
    return
  }

  // plex.direct resolves to whatever address the server advertised, including
  // private ones. Refusing those keeps this from becoming an SSRF probe into
  // Vercel's internal network, and gives a LAN-only server a clear diagnosis
  // instead of a timeout.
  const addresses = await resolve(url.hostname)
  if (addresses.length === 0) {
    res.status(502).json({ error: 'dns_failed' })
    return
  }
  if (addresses.some(isPrivate)) {
    res.status(502).json({ error: 'private_address' })
    return
  }

  const headers: Record<string, string> = { 'User-Agent': 'trakt-ketchup/0.1.0' }
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name]
    const first = Array.isArray(value) ? value[0] : value
    if (first) headers[name] = first
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const body = await upstream.text()
    res.status(upstream.status)
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')
    // The user's library listing is theirs alone; never let a cache hold it.
    res.setHeader('Cache-Control', 'no-store')
    res.send(body)
  } catch (e) {
    // Deliberately vague to the client: the useful detail (which connection
    // failed) is already known from the URL it asked for.
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    res.status(504).json({ error: timedOut ? 'upstream_timeout' : 'upstream_unreachable' })
  }
}

async function resolve(hostname: string): Promise<string[]> {
  try {
    const found = await dns.lookup(hostname, { all: true })
    return found.map((f) => f.address)
  } catch {
    return []
  }
}

/**
 * Private, loopback, link-local, and carrier-NAT ranges — anything a public
 * serverless function has no business reaching on a user's behalf.
 */
export function isPrivate(address: string): boolean {
  if (address.includes(':')) {
    const v6 = address.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (/^f[cd]/.test(v6)) return true // fc00::/7 unique-local
    if (/^fe[89ab]/.test(v6)) return true // fe80::/10 link-local
    // IPv4-mapped (::ffff:10.0.0.1) — fall through to the v4 check.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return isPrivate(mapped[1])
    return false
  }

  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}
