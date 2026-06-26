import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergePayloads } from './queue'

// The ongoing-show path fetches seasons, which goes through api() -> auth.
// Stub auth so no real token/localStorage is needed; fetch is stubbed per test.
vi.mock('./auth', () => ({
  getValidAccessToken: vi.fn(async () => 'test-token'),
}))

import { buildHistoryPayload, buildWatchlistPayload, type FeedItem } from './trakt'

// The unknown-date sentinel is a hard rule: marking must send epoch-0, never
// "now". Pin the literal so a regression here fails loudly.
const UNKNOWN_DATE = '1970-01-01T00:00:00.000Z'

function movie(): FeedItem {
  return { type: 'movie', media: { title: 'Heat', year: 1995, ids: { trakt: 1 } } }
}

function show(status: string): FeedItem {
  return { type: 'show', media: { title: 'Some Show', year: 2000, ids: { trakt: 7 }, status } }
}

describe('buildHistoryPayload', () => {
  it('marks a movie with the unknown-date sentinel', async () => {
    const p = await buildHistoryPayload(movie(), 'unknown')
    expect(p).toEqual({ movies: [{ ids: { trakt: 1 }, watched_at: UNKNOWN_DATE }] })
  })

  it('marks a movie with "released" when in release-date mode', async () => {
    const p = await buildHistoryPayload(movie(), 'released')
    expect(p).toEqual({ movies: [{ ids: { trakt: 1 }, watched_at: 'released' }] })
  })

  it('marks a completed (ended) show as the whole show, no seasons', async () => {
    const p = await buildHistoryPayload(show('ended'), 'unknown')
    expect(p).toEqual({ shows: [{ ids: { trakt: 7 }, watched_at: UNKNOWN_DATE }] })
    expect(p.shows?.[0].seasons).toBeUndefined()
  })

  it('treats a canceled show as completed too', async () => {
    const p = await buildHistoryPayload(show('canceled'), 'unknown')
    expect(p.shows?.[0].seasons).toBeUndefined()
  })

  describe('ongoing show', () => {
    const seasonsFixture = [
      // Season 0 (specials) is always dropped.
      { number: 0, episodes: [{ number: 1, first_aired: '1999-01-01T00:00:00.000Z' }] },
      {
        number: 1,
        episodes: [
          { number: 1, first_aired: '1999-01-01T00:00:00.000Z' }, // aired -> kept
          { number: 2, first_aired: '2999-01-01T00:00:00.000Z' }, // not yet aired -> dropped
          { number: 3, first_aired: null }, // no air date -> dropped
        ],
      },
      // A season with no aired episodes is dropped entirely.
      { number: 2, episodes: [{ number: 1, first_aired: '2999-01-01T00:00:00.000Z' }] },
    ]

    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => seasonsFixture })),
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    it('sends only aired, non-special episodes', async () => {
      const p = await buildHistoryPayload(show('returning series'), 'unknown')
      expect(p).toEqual({
        shows: [
          {
            ids: { trakt: 7 },
            watched_at: UNKNOWN_DATE,
            seasons: [{ number: 1, episodes: [{ number: 1 }] }],
          },
        ],
      })
    })
  })
})

describe('buildWatchlistPayload', () => {
  it('adds a whole movie by ids, with no watched_at', () => {
    expect(buildWatchlistPayload(movie())).toEqual({ movies: [{ ids: { trakt: 1 } }] })
  })

  it('adds a whole show by ids, even an ongoing one (no season math)', () => {
    expect(buildWatchlistPayload(show('returning series'))).toEqual({ shows: [{ ids: { trakt: 7 } }] })
  })
})

describe('mergePayloads', () => {
  it('combines movies and shows across payloads', () => {
    const merged = mergePayloads([
      { movies: [{ ids: { trakt: 1 }, watched_at: UNKNOWN_DATE }] },
      { shows: [{ ids: { trakt: 7 }, watched_at: UNKNOWN_DATE }] },
      { movies: [{ ids: { trakt: 2 }, watched_at: 'released' }] },
    ])
    expect(merged).toEqual({
      movies: [
        { ids: { trakt: 1 }, watched_at: UNKNOWN_DATE },
        { ids: { trakt: 2 }, watched_at: 'released' },
      ],
      shows: [{ ids: { trakt: 7 }, watched_at: UNKNOWN_DATE }],
    })
  })

  it('returns an empty payload for no input', () => {
    expect(mergePayloads([])).toEqual({})
  })
})
