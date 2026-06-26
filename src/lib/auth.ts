// OAuth (authorization code flow). The browser redirects to Trakt, Trakt
// redirects back with ?code=, and we exchange that code for tokens via the
// /api/oauth/token serverless proxy (which holds the client secret).

const CLIENT_ID = import.meta.env.VITE_TRAKT_CLIENT_ID as string
const REDIRECT_URI = import.meta.env.VITE_TRAKT_REDIRECT_URI as string
const STORAGE_KEY = 'trakt.tokens'
// CSRF guard for the OAuth round-trip: a random value we send to Trakt and
// require back on the callback, so a forged ?code= callback can't connect a
// victim's session to someone else's Trakt account.
const STATE_KEY = 'trakt.oauth_state'

export interface Tokens {
  access_token: string
  refresh_token: string
  /** Absolute epoch ms when the access token expires. */
  expires_at: number
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number // seconds
  created_at: number // epoch seconds
}

export function loadTokens(): Tokens | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? (JSON.parse(raw) as Tokens) : null
}

function saveTokens(t: Tokens) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
}

export function clearTokens() {
  localStorage.removeItem(STORAGE_KEY)
}

function toTokens(r: TokenResponse): Tokens {
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: (r.created_at + r.expires_in) * 1000,
  }
}

function randomState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Kick off the redirect to Trakt's authorize page. */
export function beginLogin() {
  const state = randomState()
  sessionStorage.setItem(STATE_KEY, state)
  const url = new URL('https://trakt.tv/oauth/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('state', state)
  window.location.href = url.toString()
}

// OAuth codes are single-use. React 18 StrictMode runs effects twice on mount
// in dev, which would exchange the same code twice (the second exchange 403s).
// Dedupe so concurrent callers share one in-flight exchange.
let exchangeInFlight: Promise<Tokens | null> | null = null

/** If the URL has a ?code=, exchange it for tokens and clean the URL. */
export function completeLoginIfRedirected(): Promise<Tokens | null> {
  if (exchangeInFlight) return exchangeInFlight

  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  if (!code) return Promise.resolve(null)

  exchangeInFlight = (async () => {
    // Verify the CSRF state before spending the single-use code. The check is
    // inside the deduped promise so StrictMode's double-invoke (which would
    // otherwise consume the stored state on the first run and fail the second)
    // shares one result.
    const returnedState = params.get('state')
    const expectedState = sessionStorage.getItem(STATE_KEY)
    sessionStorage.removeItem(STATE_KEY)
    if (!expectedState || returnedState !== expectedState) {
      throw new Error('OAuth state mismatch (possible CSRF). Please connect again.')
    }

    const res = await fetch('/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Token exchange failed: ${res.status} ${detail}`.trim())
    }

    const tokens = toTokens((await res.json()) as TokenResponse)
    saveTokens(tokens)
    window.history.replaceState({}, '', REDIRECT_URI === window.location.origin ? '/' : window.location.pathname)
    return tokens
  })()

  return exchangeInFlight
}

/** Return a valid access token, refreshing first if it is close to expiry. */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null

  // Refresh with a 5-minute safety margin.
  if (Date.now() < tokens.expires_at - 5 * 60 * 1000) {
    return tokens.access_token
  }

  const res = await fetch('/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
  })
  if (!res.ok) {
    clearTokens()
    return null
  }
  const refreshed = toTokens((await res.json()) as TokenResponse)
  saveTokens(refreshed)
  return refreshed.access_token
}
