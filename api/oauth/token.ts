import type { VercelRequest, VercelResponse } from '@vercel/node'

// OAuth token proxy. This is the ONLY thing that must run server-side:
// it holds the client secret and performs the code->token exchange and
// refresh-token rotation. All other Trakt calls go directly from the browser.
//
// POST /api/oauth/token
//   { "grant_type": "authorization_code", "code": "..." }
//   { "grant_type": "refresh_token", "refresh_token": "..." }

const TRAKT_TOKEN_URL = 'https://api.trakt.tv/oauth/token'

// Origins allowed to use this proxy. Derived from the app's own redirect URI,
// plus an optional ALLOWED_ORIGINS override (comma-separated) and localhost for
// dev. Locking this down stops third parties / scripts from burning our Trakt
// app's rate limit and function quota through our credentials.
function allowedOrigins(): Set<string> {
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

// Best-effort per-IP rate limit. This is an in-memory fixed window that only
// covers a single warm function instance (Vercel may run several), so it's a
// speed bump against abuse, not a hard guarantee. Legit use is a couple of
// token calls per login plus the occasional refresh, well under the cap.
const RATE_LIMIT = 20 // requests
const RATE_WINDOW_MS = 60_000 // per minute, per IP
const hits = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first || (req.headers['x-real-ip'] as string) || 'unknown'
}

/** Returns true if the caller is over the limit for the current window. */
function rateLimited(ip: string): boolean {
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
  return entry.count > RATE_LIMIT
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  // Browsers always send Origin on POST; requiring it in the allowlist rejects
  // both cross-site browser calls and credential-less scripted abuse (curl).
  const origin = req.headers.origin
  if (!origin || !allowedOrigins().has(origin)) {
    res.status(403).json({ error: 'forbidden_origin' })
    return
  }

  if (rateLimited(clientIp(req))) {
    res.status(429).json({ error: 'rate_limited' })
    return
  }

  const clientId = process.env.VITE_TRAKT_CLIENT_ID
  const clientSecret = process.env.TRAKT_CLIENT_SECRET
  const redirectUri = process.env.VITE_TRAKT_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).json({ error: 'server_misconfigured', detail: 'Missing Trakt env vars' })
    return
  }

  const { grant_type, code, refresh_token } = (req.body ?? {}) as {
    grant_type?: string
    code?: string
    refresh_token?: string
  }

  if (grant_type !== 'authorization_code' && grant_type !== 'refresh_token') {
    res.status(400).json({ error: 'invalid_grant_type' })
    return
  }

  const body =
    grant_type === 'authorization_code'
      ? { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type }
      : { refresh_token, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type }

  const traktRes = await fetch(TRAKT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Cloudflare (in front of api.trakt.tv) 403s server-side requests with no
      // User-Agent. Node's fetch omits it, so set one explicitly.
      'User-Agent': 'trakt-ketchup/0.1.0',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
    body: JSON.stringify(body),
  })

  const raw = await traktRes.text()
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { error: 'trakt_non_json_response', detail: raw.slice(0, 500) }
  }
  if (!traktRes.ok) {
    // Surface Trakt's rejection reason in the dev console; the client never
    // sees the secret, only Trakt's (safe) error body.
    console.error('[oauth] Trakt token exchange failed', traktRes.status, raw.slice(0, 500))
  }
  // Forward Trakt's status. The token payload is safe for the client
  // (access_token, refresh_token, expires_in) — the secret never leaves here.
  res.status(traktRes.status).json(data)
}
