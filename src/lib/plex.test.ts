import { describe, expect, it } from 'vitest'
import { isWatched, parseGuids } from './plex'

describe('parseGuids', () => {
  it('reads the modern multi-agent Guid array', () => {
    expect(
      parseGuids({ Guid: [{ id: 'imdb://tt0111161' }, { id: 'tmdb://278' }, { id: 'tvdb://12345' }] }),
    ).toEqual({ imdb: 'tt0111161', tmdb: '278', tvdb: '12345' })
  })

  it('falls back to a legacy agent guid', () => {
    expect(parseGuids({ guid: 'com.plexapp.agents.imdb://tt0111161?lang=en' })).toEqual({
      imdb: 'tt0111161',
    })
  })

  // Legacy TVDB guids carry a season/episode path that is not part of the id.
  it('strips the path from a legacy tvdb guid', () => {
    expect(parseGuids({ guid: 'com.plexapp.agents.thetvdb://73141/1/1?lang=en' })).toEqual({
      tvdb: '73141',
    })
  })

  it('prefers the Guid array when both are present', () => {
    expect(
      parseGuids({ guid: 'com.plexapp.agents.imdb://tt9999999?lang=en', Guid: [{ id: 'imdb://tt0111161' }] }),
    ).toEqual({ imdb: 'tt0111161' })
  })

  it('ignores plex-native and unrecognized guids', () => {
    expect(parseGuids({ guid: 'plex://movie/5d776826880197001ec90e8e' })).toEqual({})
    expect(parseGuids({})).toEqual({})
  })
})

describe('isWatched', () => {
  it('treats a played movie as watched', () => {
    expect(isWatched({ viewCount: 1 })).toBe(true)
    expect(isWatched({ viewCount: 0 })).toBe(false)
    expect(isWatched({})).toBe(false)
  })

  it('only counts a show as watched once every episode is', () => {
    expect(isWatched({ leafCount: 10, viewedLeafCount: 10 })).toBe(true)
    expect(isWatched({ leafCount: 10, viewedLeafCount: 9 })).toBe(false)
    expect(isWatched({ leafCount: 10, viewedLeafCount: 0 })).toBe(false)
    expect(isWatched({ leafCount: 10 })).toBe(false)
  })

  // An empty show (no episodes on disk) must not read as fully watched.
  it('does not call an empty show watched', () => {
    expect(isWatched({ leafCount: 0, viewedLeafCount: 0 })).toBe(false)
  })
})
