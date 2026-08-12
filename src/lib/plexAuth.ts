// Plex authentication: the plex.tv PIN flow.
//
// Unlike Trakt's OAuth, this needs no client secret, so the whole exchange
// happens in the browser and there is no serverless proxy involved. We create a
// PIN, send the user to app.plex.tv to approve it, and poll the PIN until it
// comes back carrying an auth token.
//
// The client identifier must be stable across the create/poll pair (Plex ties
// the PIN to it), so it is generated once and kept in localStorage.

const PLEX_TV = 'https://plex.tv/api/v2'

const CLIENT_ID_KEY = 'plex.clientId'
const TOKEN_KEY = 'plex.token'
const PENDING_PIN_KEY = 'plex.pendingPin'

export const PLEX_PRODUCT = 'Trakt Ketchup'

/** Stable per-browser identifier Plex uses to tie a PIN to this client. */
export function clientIdentifier(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CLIENT_ID_KEY, id)
  }
  return id
}

/** Headers every plex.tv call needs so the account sees a named client. */
export function plexHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Version': '1.0',
    'X-Plex-Client-Identifier': clientIdentifier(),
    'X-Plex-Platform': 'Web',
  }
  if (token) headers['X-Plex-Token'] = token
  return headers
}

export function loadPlexToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function clearPlexToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(PENDING_PIN_KEY)
}

interface Pin {
  id: number
  code: string
  authToken: string | null
}

/**
 * Create a PIN and hand off to app.plex.tv. Plex sends the browser back to
 * `forwardUrl` once the user approves, at which point the PIN carries a token.
 */
export async function beginPlexLogin(forwardUrl: string) {
  const res = await fetch(`${PLEX_TV}/pins?strong=true`, {
    method: 'POST',
    headers: plexHeaders(),
  })
  if (!res.ok) throw new Error(`Plex pin request failed (${res.status})`)
  const pin = (await res.json()) as Pin
  localStorage.setItem(PENDING_PIN_KEY, String(pin.id))

  const params = new URLSearchParams({
    clientID: clientIdentifier(),
    code: pin.code,
    forwardUrl,
    'context[device][product]': PLEX_PRODUCT,
  })
  // The auth page reads its parameters from the fragment, not the query string.
  location.href = `https://app.plex.tv/auth#?${params.toString()}`
}

/**
 * If a PIN is waiting from a previous `beginPlexLogin`, poll it for the token.
 *
 * Plex has usually attached the token by the time it forwards us back, but the
 * write can lag the redirect by a beat, so this retries briefly before giving
 * up. A PIN that never resolves is dropped rather than left to block future
 * attempts.
 */
export async function completePlexLoginIfRedirected(): Promise<string | null> {
  const pending = localStorage.getItem(PENDING_PIN_KEY)
  if (!pending) return null

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${PLEX_TV}/pins/${pending}`, { headers: plexHeaders() })
    if (res.ok) {
      const pin = (await res.json()) as Pin
      if (pin.authToken) {
        localStorage.setItem(TOKEN_KEY, pin.authToken)
        localStorage.removeItem(PENDING_PIN_KEY)
        return pin.authToken
      }
    } else if (res.status === 404) {
      break // expired or already consumed
    }
    await new Promise((r) => setTimeout(r, 600))
  }

  localStorage.removeItem(PENDING_PIN_KEY)
  return null
}
