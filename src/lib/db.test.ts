import { describe, expect, it } from 'vitest'
import { identityKeys, keyOf } from './db'

// identityKeys is what lets a Plex card (IMDb/TMDB/TVDB only) be recognised as
// already-watched from history Trakt recorded under a Trakt id, with no lookup
// to bridge them. If these keys stop lining up, the deck silently re-offers
// titles the user has already answered.
describe('identityKeys', () => {
  it('emits a key per id the title is known by', () => {
    expect(identityKeys('movie', { trakt: 1, imdb: 'tt0111161', tmdb: 278 })).toEqual([
      'movie:1',
      'movie:imdb:tt0111161',
      'movie:tmdb:278',
    ])
  })

  it('lets a Plex-shaped title and a Trakt-shaped one meet on a shared key', () => {
    const fromTrakt = identityKeys('show', { trakt: 1390, imdb: 'tt0944947', tvdb: 121361 })
    const fromPlex = identityKeys('show', { imdb: 'tt0944947' })
    expect(fromPlex.every((k) => fromTrakt.includes(k))).toBe(true)
  })

  // The Trakt-id form predates external-id keys; changing it would orphan every
  // cache and skip-memory entry already in users' browsers.
  it('keeps the legacy Trakt-id key format', () => {
    expect(identityKeys('movie', { trakt: 42 })[0]).toBe('movie:42')
    expect(keyOf('movie', 42)).toBe('movie:42')
  })

  it('keeps movies and shows apart', () => {
    expect(identityKeys('movie', { imdb: 'tt1' })).not.toEqual(identityKeys('show', { imdb: 'tt1' }))
  })

  // A numeric Trakt id can never collide with a provider-prefixed key.
  it('cannot collide across id namespaces', () => {
    const keys = identityKeys('movie', { trakt: 278, tmdb: 278 })
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('skips absent ids rather than emitting empty keys', () => {
    expect(identityKeys('movie', {})).toEqual([])
    expect(identityKeys('movie', { imdb: '', tmdb: undefined })).toEqual([])
  })

  it('treats id 0 as present, not missing', () => {
    expect(identityKeys('movie', { tmdb: 0 })).toEqual(['movie:tmdb:0'])
  })
})
