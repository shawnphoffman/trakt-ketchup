import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWatchedMovieIds, getWatchedShowIds, getWatchlistMovieIds } from './trakt'

vi.mock('./auth', () => ({ getValidAccessToken: async () => 'test-token' }))

// Trakt caps these responses at 100. Reading only the first page silently
// truncates the exclusion cache, and the symptom is indirect: the feed re-offers
// watched titles that happened to fall beyond the cutoff, which reads as broken
// matching rather than missing data.

const calls: string[] = []

function respondWith(pages: number[]) {
  calls.length = 0
  let page = 0
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    const count = pages[page++] ?? 0
    return {
      ok: true,
      status: 200,
      json: async () =>
        Array.from({ length: count }, (_, i) => ({
          movie: { ids: { trakt: page * 1000 + i } },
          show: { ids: { trakt: page * 1000 + i } },
        })),
    }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('paginated sync lists', () => {
  it('follows pages until a short one ends the list', async () => {
    respondWith([100, 100, 5])
    expect((await getWatchedMovieIds()).length).toBe(205)
    expect(calls.length).toBe(3)
    expect(calls[0]).toContain('page=1&limit=100')
    expect(calls[2]).toContain('page=3&limit=100')
  })

  // The exact case that produced a suspiciously round 200: two endpoints each
  // truncated at their first page.
  it('does not stop at the cap when more remains', async () => {
    respondWith([100, 100])
    expect((await getWatchedMovieIds()).length).toBe(200)
    expect(calls.length).toBe(3) // third page came back empty and ended it
  })

  it('stops after one request when the list is short', async () => {
    respondWith([12])
    expect((await getWatchlistMovieIds()).length).toBe(12)
    expect(calls.length).toBe(1)
  })

  it('appends to an existing query string rather than starting a new one', async () => {
    respondWith([3])
    await getWatchedShowIds()
    expect(calls[0]).toContain('?extended=noseasons&page=1&limit=100')
    expect(calls[0]).not.toContain('?page=')
  })

  it('handles an empty history without looping', async () => {
    respondWith([0])
    expect((await getWatchedMovieIds()).length).toBe(0)
    expect(calls.length).toBe(1)
  })
})
