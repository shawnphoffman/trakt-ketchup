import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowedOrigins, clientIp, rateLimited } from '../_guard'

// OAuth token proxy. This holds the client secret and performs the code->token
// exchange and refresh-token rotation; all other Trakt calls go directly from
// the browser. (The Plex library proxy is the app's only other server-side
// piece — see api/plex/proxy.ts for why that one is unavoidable.)
//
// POST /api/oauth/token
//   { "grant_type": "authorization_code", "code": "..." }
//   { "grant_type": "refresh_token", "refresh_token": "..." }

const TRAKT_TOKEN_URL = 'https://api.trakt.tv/oauth/token'

// Legit use is a couple of token calls per login plus the occasional refresh,
// well under the cap.
const RATE_LIMIT = 20 // requests per minute, per IP

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

  if (rateLimited('oauth', clientIp(req), RATE_LIMIT)) {
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
