import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getActiveSkipKeys,
  getWatchedKeys,
  getWatchlistKeys,
  identityKeys,
  markUnwatchedLocal,
  markWatchedLocal,
  recordSkip,
  removeSkip,
  replaceWatchedCache,
  replaceWatchlistCache,
} from './db'

// Exercises the real IndexedDB path, not just the key function. This is what
// actually decides whether an already-watched title is filtered out of the
// feed, and a title leaking through looks identical to a matching bug.

const MATRIX = { trakt: 481, slug: 'the-matrix-1999', imdb: 'tt0133093', tmdb: 603 }

async function reset() {
  await replaceWatchedCache([])
  await replaceWatchlistCache([])
}

describe('watched cache round-trip', () => {
  beforeEach(reset)

  it('stores a key for every id, so any of them excludes the title', async () => {
    await replaceWatchedCache([{ type: 'movie', ids: MATRIX }])
    const keys = await getWatchedKeys()

    // However the feed learns about it, one of its keys must be present.
    expect(identityKeys('movie', MATRIX).some((k) => keys.has(k))).toBe(true)
    // A Plex card carries no Trakt id and must still match.
    expect(identityKeys('movie', { imdb: 'tt0133093' }).every((k) => keys.has(k))).toBe(true)
  })

  it('replaces server rows wholesale', async () => {
    await replaceWatchedCache([{ type: 'movie', ids: MATRIX }])
    await replaceWatchedCache([{ type: 'movie', ids: { trakt: 999, imdb: 'tt9' } }])
    const keys = await getWatchedKeys()
    expect(keys.has('movie:481')).toBe(false)
    expect(keys.has('movie:999')).toBe(true)
  })

  // A local mark whose flush failed must survive a resync, or the title comes
  // back around and the user answers it twice.
  it('keeps optimistic local marks through a resync', async () => {
    await markWatchedLocal('movie', identityKeys('movie', { imdb: 'tt0133093' }))
    await replaceWatchedCache([{ type: 'movie', ids: { trakt: 999 } }])
    expect((await getWatchedKeys()).has('movie:imdb:tt0133093')).toBe(true)
  })

  it('undoes a local mark across every key', async () => {
    const keys = identityKeys('movie', MATRIX)
    await markWatchedLocal('movie', keys)
    await markUnwatchedLocal(keys)
    const stored = await getWatchedKeys()
    expect(keys.some((k) => stored.has(k))).toBe(false)
  })

  it('keeps the watchlist separate from watched', async () => {
    await replaceWatchlistCache([{ type: 'movie', ids: MATRIX }])
    expect((await getWatchedKeys()).size).toBe(0)
    expect((await getWatchlistKeys()).has('movie:481')).toBe(true)
  })
})

describe('skip memory round-trip', () => {
  it('suppresses a skip until it expires, and go-back clears it', async () => {
    const now = Date.now()
    const keys = identityKeys('show', { trakt: 1390, imdb: 'tt0944947' })
    await recordSkip('show', keys, now)

    expect((await getActiveSkipKeys(now)).has('show:1390')).toBe(true)
    // 180-day TTL: still suppressed at 179 days, eligible again after.
    expect((await getActiveSkipKeys(now + 179 * 86_400_000)).has('show:1390')).toBe(true)
    expect((await getActiveSkipKeys(now + 181 * 86_400_000)).has('show:1390')).toBe(false)

    await removeSkip(keys)
    expect((await getActiveSkipKeys(now)).size).toBe(0)
  })
})
