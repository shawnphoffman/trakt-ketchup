import type { VercelRequest, VercelResponse } from '@vercel/node'

// OAuth token proxy. This is the ONLY thing that must run server-side:
// it holds the client secret and performs the code->token exchange and
// refresh-token rotation. All other Trakt calls go directly from the browser.
//
// POST /api/oauth/token
//   { "grant_type": "authorization_code", "code": "..." }
//   { "grant_type": "refresh_token", "refresh_token": "..." }

const TRAKT_TOKEN_URL = 'https://api.trakt.tv/oauth/token'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
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
