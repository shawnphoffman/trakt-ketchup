// IndexedDB layer: the watched + watchlist exclusion caches and the skip-memory.
//
// Rows are keyed by *identity*, not by a single id, because the two decks know
// titles by different names. The Trakt feed has Trakt ids; a Plex item only
// carries IMDb/TMDB/TVDB ids and is deliberately never looked up (that lookup
// is what was rate-limiting us). Writing one row per id a title is known by
// lets a Plex item match history recorded under a Trakt id with nothing to
// bridge them at request time.
//
// The Trakt-id key format is unchanged from when it was the only key, so caches
// and skip-memory written by earlier versions stay valid and no migration is
// needed; provider-prefixed keys can't collide with the numeric form.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type MediaType = 'movie' | 'show'

export interface ExternalIds {
  trakt?: number
  imdb?: string
  tmdb?: number
  tvdb?: number
}

export function keyOf(type: MediaType, traktId: number): string {
  return `${type}:${traktId}`
}

/** Every key a title is known by, most authoritative first. */
export function identityKeys(type: MediaType, ids: ExternalIds): string[] {
  const keys: string[] = []
  if (ids.trakt !== undefined) keys.push(keyOf(type, ids.trakt))
  if (ids.imdb) keys.push(`${type}:imdb:${ids.imdb}`)
  if (ids.tmdb !== undefined) keys.push(`${type}:tmdb:${ids.tmdb}`)
  if (ids.tvdb !== undefined) keys.push(`${type}:tvdb:${ids.tvdb}`)
  return keys
}

/**
 * Where a cache row came from. `trakt` rows are a mirror of the server and are
 * replaced wholesale on every resync. `local` rows are optimistic marks made in
 * this browser that Trakt may not have accepted yet; a resync must NOT delete
 * them, or a mark whose flush failed would resurface in the feed.
 */
type CacheSource = 'trakt' | 'local'

interface CacheRow {
  key: string
  type: MediaType
  addedAt: number
  /** Absent on rows written before this field existed; treated as `trakt`. */
  source?: CacheSource
  /** Legacy field, still written by older versions. Unused when reading. */
  traktId?: number
}

interface KetchupDB extends DBSchema {
  watched: {
    key: string
    value: CacheRow
  }
  watchlist: {
    key: string
    value: CacheRow
  }
  skips: {
    key: string
    // `expiresAt` is when the item becomes eligible to resurface.
    value: { key: string; type: MediaType; expiresAt: number; traktId?: number }
  }
  meta: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<KetchupDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<KetchupDB>('trakt-catchup', 2, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore('watched', { keyPath: 'key' })
          database.createObjectStore('skips', { keyPath: 'key' })
          database.createObjectStore('meta')
        }
        if (oldVersion < 2) {
          database.createObjectStore('watchlist', { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}

// ---- watched cache ---------------------------------------------------------

export async function getWatchedKeys(): Promise<Set<string>> {
  const all = await (await db()).getAllKeys('watched')
  return new Set(all as string[])
}

export async function markWatchedLocal(type: MediaType, keys: string[]) {
  await putLocal('watched', type, keys)
}

/** Undo an optimistic local watched mark (used by go-back). */
export async function markUnwatchedLocal(keys: string[]) {
  await deleteKeys('watched', keys)
}

/** Bulk-load the watched cache from a Trakt sync. See `replaceTraktRows`. */
export async function replaceWatchedCache(entries: Array<{ type: MediaType; ids: ExternalIds }>) {
  await replaceTraktRows('watched', entries)
}

// ---- watchlist cache -------------------------------------------------------

export async function getWatchlistKeys(): Promise<Set<string>> {
  const all = await (await db()).getAllKeys('watchlist')
  return new Set(all as string[])
}

export async function markWatchlistLocal(type: MediaType, keys: string[]) {
  await putLocal('watchlist', type, keys)
}

/** Undo an optimistic local watchlist mark (used by go-back). */
export async function markUnwatchlistLocal(keys: string[]) {
  await deleteKeys('watchlist', keys)
}

/** Bulk-load the watchlist cache from a Trakt sync. See `replaceTraktRows`. */
export async function replaceWatchlistCache(entries: Array<{ type: MediaType; ids: ExternalIds }>) {
  await replaceTraktRows('watchlist', entries)
}

async function putLocal(store: 'watched' | 'watchlist', type: MediaType, keys: string[]) {
  const d = await db()
  const tx = d.transaction(store, 'readwrite')
  const now = Date.now()
  for (const key of keys) {
    await tx.store.put({ key, type, addedAt: now, source: 'local' })
  }
  await tx.done
}

async function deleteKeys(store: 'watched' | 'watchlist' | 'skips', keys: string[]) {
  const d = await db()
  const tx = d.transaction(store, 'readwrite')
  for (const key of keys) await tx.store.delete(key)
  await tx.done
}

/**
 * Refresh a cache from Trakt: drop every previously-synced (`trakt`) row and
 * write the new server state, but leave optimistic `local` rows alone. Those
 * represent marks made in this browser; wiping them would let a title the user
 * already answered come back around if its flush hadn't landed yet. A local row
 * that Trakt did accept gets overwritten here (same key) and becomes a `trakt`
 * row, so the two converge on the next sync.
 */
async function replaceTraktRows(
  store: 'watched' | 'watchlist',
  entries: Array<{ type: MediaType; ids: ExternalIds }>,
) {
  const d = await db()
  const tx = d.transaction(store, 'readwrite')
  for (const row of await tx.store.getAll()) {
    if (row.source !== 'local') await tx.store.delete(row.key)
  }
  const now = Date.now()
  for (const e of entries) {
    for (const key of identityKeys(e.type, e.ids)) {
      await tx.store.put({ key, type: e.type, addedAt: now, source: 'trakt' })
    }
  }
  await tx.done
}

// ---- skip memory (TTL) -----------------------------------------------------

const SKIP_TTL_MS = 1000 * 60 * 60 * 24 * 180 // 180 days

export async function recordSkip(type: MediaType, keys: string[], now: number) {
  const d = await db()
  const tx = d.transaction('skips', 'readwrite')
  for (const key of keys) {
    await tx.store.put({ key, type, expiresAt: now + SKIP_TTL_MS })
  }
  await tx.done
}

/** Undo a skip-memory entry (used by go-back). */
export async function removeSkip(keys: string[]) {
  await deleteKeys('skips', keys)
}

/** Keys that are currently suppressed (skipped and not yet expired). */
export async function getActiveSkipKeys(now: number): Promise<Set<string>> {
  const all = await (await db()).getAll('skips')
  const active = new Set<string>()
  for (const s of all) {
    if (s.expiresAt > now) active.add(s.key)
  }
  return active
}

// ---- misc meta -------------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined
}

export async function setMeta(key: string, value: unknown) {
  await (await db()).put('meta', value, key)
}
