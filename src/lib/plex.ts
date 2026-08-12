// Direct browser -> Plex client: server discovery, library sections, and the
// unwatched item listing that feeds the /plex page.
//
// Two hosts are involved. plex.tv is the account API (which servers do you
// own?), and the Plex Media Server itself is reached over its own HTTPS
// connection URI. Both send permissive CORS headers, which is what makes a
// browser-only client possible.
//
// Reaching the server MUST use the `uri` Plex hands back (a *.plex.direct
// hostname), not the bare LAN address: plex.direct resolves to the same private
// IP but carries a real certificate, so an HTTPS page can talk to it without
// tripping mixed-content blocking.

import type { MediaType } from './db'
import { plexHeaders } from './plexAuth'

const PLEX_TV = 'https://plex.tv/api/v2'

/** How long to wait for a candidate connection to answer before moving on. */
const PROBE_TIMEOUT_MS = 4000

/** Items pulled per page from a library section. */
const PAGE_SIZE = 200

export interface PlexServer {
  name: string
  machineIdentifier: string
  /** Base URI (no trailing slash) that answered a probe. */
  uri: string
  /** Per-server token from plex.tv; preferred over the account token. */
  token: string
}

export interface PlexSection {
  key: string
  title: string
  type: MediaType
}

/** External ids scraped off a Plex item, used to find it on Trakt. */
export interface PlexGuids {
  imdb?: string
  tmdb?: string
  tvdb?: string
}

export interface PlexCandidate {
  ratingKey: string
  title: string
  year: number | null
  type: MediaType
  guids: PlexGuids
}

// ---- server discovery ------------------------------------------------------

interface ResourceConnection {
  uri: string
  local: boolean
  relay: boolean
  protocol: string
}

interface Resource {
  name: string
  clientIdentifier: string
  provides: string
  accessToken?: string
  connections?: ResourceConnection[]
}

/**
 * Pick a working server. plex.tv lists every connection a server advertises
 * (LAN, WAN, relay); we probe them in preference order and take the first that
 * answers, because only the user's own network knows which is reachable.
 */
export async function discoverServer(accountToken: string): Promise<PlexServer> {
  const res = await fetch(`${PLEX_TV}/resources?includeHttps=1&includeRelay=1`, {
    headers: plexHeaders(accountToken),
  })
  if (!res.ok) throw new Error(`Plex resources failed (${res.status})`)
  const resources = (await res.json()) as Resource[]
  const servers = resources.filter((r) => r.provides.split(',').includes('server'))
  if (servers.length === 0) throw new Error('No Plex Media Server found on this account.')

  for (const server of servers) {
    const uri = await firstReachable(server.connections ?? [])
    if (uri) {
      return {
        name: server.name,
        machineIdentifier: server.clientIdentifier,
        uri,
        token: server.accessToken ?? accountToken,
      }
    }
  }

  throw new Error(
    "Couldn't reach your Plex server from this browser. Check that it's online and that remote access or the local network is available.",
  )
}

/** LAN first (fastest), then direct WAN, then relay (slow, last resort). */
function rankConnections(connections: ResourceConnection[]): ResourceConnection[] {
  const https = connections.filter((c) => c.protocol === 'https')
  const score = (c: ResourceConnection) => (c.relay ? 2 : c.local ? 0 : 1)
  return [...https].sort((a, b) => score(a) - score(b))
}

async function firstReachable(connections: ResourceConnection[]): Promise<string | null> {
  for (const connection of rankConnections(connections)) {
    const uri = connection.uri.replace(/\/+$/, '')
    if (await probe(uri)) return uri
  }
  return null
}

/** `/identity` needs no token and is the cheapest "are you there?" call. */
async function probe(uri: string): Promise<boolean> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${uri}/identity`, { headers: { accept: 'application/json' }, signal: abort.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---- library sections ------------------------------------------------------

interface SectionDirectory {
  key: string
  title: string
  type: string
}

async function serverJson<T>(server: PlexServer, path: string): Promise<T> {
  const res = await fetch(`${server.uri}${path}`, { headers: plexHeaders(server.token) })
  if (!res.ok) throw new Error(`Plex ${path} -> ${res.status}`)
  return (await res.json()) as T
}

export async function getSections(server: PlexServer): Promise<PlexSection[]> {
  const body = await serverJson<{ MediaContainer?: { Directory?: SectionDirectory[] } }>(
    server,
    '/library/sections',
  )
  const dirs = body.MediaContainer?.Directory ?? []
  return dirs
    .filter((d) => d.type === 'movie' || d.type === 'show')
    .map((d) => ({ key: d.key, title: d.title, type: d.type as MediaType }))
}

// ---- library items ---------------------------------------------------------

interface PlexMetadata {
  ratingKey: string
  title: string
  year?: number
  type: string
  /** Legacy single-agent guid, e.g. "com.plexapp.agents.imdb://tt0111161?lang=en". */
  guid?: string
  /** Modern multi-agent guids, e.g. [{ id: "imdb://tt0111161" }]. */
  Guid?: { id: string }[]
  viewCount?: number
  leafCount?: number
  viewedLeafCount?: number
}

/**
 * Every item in a section that Plex does NOT consider watched.
 *
 * "Watched" means different things per type: a movie has a `viewCount`, while a
 * show is only fully watched once every episode is (`viewedLeafCount` reaching
 * `leafCount`). A part-way show still counts as unwatched here, since the point
 * of the page is asking about things Plex has no record of you finishing.
 *
 * Movie sections get the server-side `unwatched=1` filter to cut transfer on
 * large libraries; the client-side check below is what actually decides, so the
 * result is the same either way.
 */
export async function getUnwatchedItems(
  server: PlexServer,
  section: PlexSection,
  onProgress?: (loaded: number) => void,
): Promise<PlexCandidate[]> {
  const filter = section.type === 'movie' ? '&unwatched=1' : ''
  const out: PlexCandidate[] = []

  for (let start = 0; ; start += PAGE_SIZE) {
    const body = await serverJson<{ MediaContainer?: { Metadata?: PlexMetadata[] } }>(
      server,
      `/library/sections/${section.key}/all?includeGuids=1${filter}` +
        `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`,
    )
    const rows = body.MediaContainer?.Metadata ?? []
    for (const row of rows) {
      if (isWatched(row)) continue
      out.push({
        ratingKey: row.ratingKey,
        title: row.title,
        year: row.year ?? null,
        type: section.type,
        guids: parseGuids(row),
      })
    }
    onProgress?.(out.length)
    if (rows.length < PAGE_SIZE) break
  }

  return out
}

export function isWatched(row: {
  type?: string
  viewCount?: number
  leafCount?: number
  viewedLeafCount?: number
}): boolean {
  if (row.leafCount !== undefined) {
    // Show: watched only once every episode has been.
    return (row.viewedLeafCount ?? 0) >= row.leafCount && row.leafCount > 0
  }
  return (row.viewCount ?? 0) > 0
}

/**
 * Pull external ids out of a Plex item. Modern libraries carry a `Guid` array
 * from the Plex Movie/TV agents; libraries still on a legacy agent only have
 * the single `guid` attribute, which encodes one provider in its scheme.
 */
export function parseGuids(row: { guid?: string; Guid?: { id: string }[] }): PlexGuids {
  const guids: PlexGuids = {}

  for (const entry of row.Guid ?? []) {
    assign(guids, entry.id)
  }
  if (!guids.imdb && !guids.tmdb && !guids.tvdb && row.guid) {
    // e.g. "com.plexapp.agents.imdb://tt0111161?lang=en" -> "imdb://tt0111161"
    assign(guids, row.guid.replace(/^com\.plexapp\.agents\./, '').split('?')[0])
  }
  return guids
}

function assign(guids: PlexGuids, raw: string) {
  const match = /^([a-z]+):\/\/(.+)$/.exec(raw)
  if (!match) return
  const [, scheme, value] = match
  // Legacy agents nest a path (e.g. "thetvdb://73141/1/1"); the id is the head.
  const id = value.split('/')[0]
  if (!id) return
  if (scheme === 'imdb') guids.imdb ??= id
  else if (scheme === 'tmdb' || scheme === 'themoviedb') guids.tmdb ??= id
  else if (scheme === 'tvdb' || scheme === 'thetvdb') guids.tvdb ??= id
}
