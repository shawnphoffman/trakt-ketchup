// IndexedDB layer: the watched-history cache and the skip-memory (TTL).
// Keyed by `${mediaType}:${traktId}` so movies and shows never collide.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type MediaType = 'movie' | 'show'

export function keyOf(type: MediaType, traktId: number): string {
  return `${type}:${traktId}`
}

interface KetchupDB extends DBSchema {
  watched: {
    key: string
    value: { key: string; type: MediaType; traktId: number; addedAt: number }
  }
  watchlist: {
    key: string
    value: { key: string; type: MediaType; traktId: number; addedAt: number }
  }
  skips: {
    key: string
    // `expiresAt` is when the item becomes eligible to resurface.
    value: { key: string; type: MediaType; traktId: number; expiresAt: number }
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

export async function markWatchedLocal(type: MediaType, traktId: number) {
  const d = await db()
  await d.put('watched', { key: keyOf(type, traktId), type, traktId, addedAt: Date.now() })
}

/** Undo an optimistic local watched mark (used by go-back). */
export async function markUnwatchedLocal(type: MediaType, traktId: number) {
  const d = await db()
  await d.delete('watched', keyOf(type, traktId))
}

/** Bulk-load the watched cache from a Trakt sync, replacing what we have. */
export async function replaceWatchedCache(entries: Array<{ type: MediaType; traktId: number }>) {
  const d = await db()
  const tx = d.transaction('watched', 'readwrite')
  await tx.store.clear()
  const now = Date.now()
  for (const e of entries) {
    await tx.store.put({ key: keyOf(e.type, e.traktId), type: e.type, traktId: e.traktId, addedAt: now })
  }
  await tx.done
}

// ---- watchlist cache -------------------------------------------------------
// Mirrors the watched cache: lets the feed exclude titles already on the user's
// Trakt watchlist so they don't resurface.

export async function getWatchlistKeys(): Promise<Set<string>> {
  const all = await (await db()).getAllKeys('watchlist')
  return new Set(all as string[])
}

export async function markWatchlistLocal(type: MediaType, traktId: number) {
  const d = await db()
  await d.put('watchlist', { key: keyOf(type, traktId), type, traktId, addedAt: Date.now() })
}

/** Undo an optimistic local watchlist mark (used by go-back). */
export async function markUnwatchlistLocal(type: MediaType, traktId: number) {
  const d = await db()
  await d.delete('watchlist', keyOf(type, traktId))
}

/** Bulk-load the watchlist cache from a Trakt sync, replacing what we have. */
export async function replaceWatchlistCache(entries: Array<{ type: MediaType; traktId: number }>) {
  const d = await db()
  const tx = d.transaction('watchlist', 'readwrite')
  await tx.store.clear()
  const now = Date.now()
  for (const e of entries) {
    await tx.store.put({ key: keyOf(e.type, e.traktId), type: e.type, traktId: e.traktId, addedAt: now })
  }
  await tx.done
}

// ---- skip memory (TTL) -----------------------------------------------------

const SKIP_TTL_MS = 1000 * 60 * 60 * 24 * 180 // 180 days

export async function recordSkip(type: MediaType, traktId: number, now: number) {
  const d = await db()
  await d.put('skips', { key: keyOf(type, traktId), type, traktId, expiresAt: now + SKIP_TTL_MS })
}

/** Undo a skip-memory entry (used by go-back). */
export async function removeSkip(type: MediaType, traktId: number) {
  const d = await db()
  await d.delete('skips', keyOf(type, traktId))
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
