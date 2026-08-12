// Feed engine for the /plex page: the same one-card-at-a-time deck as the Trakt
// feed, but the well is the user's own Plex libraries instead of Trakt's
// popularity charts.
//
// Shape of the pipeline:
//   1. discover the server and list the selected sections
//   2. pull everything Plex does NOT consider watched (that whole set is the
//      question: "you own it and never played it here, but did you see it?")
//   3. resolve each item's GUIDs to a Trakt title, lazily, just ahead of the UI
//   4. drop anything already in Trakt history/watchlist or under skip-memory
//
// Step 3 is what lets everything downstream (the write queue, the exclusion
// caches, go-back, the aired-seasons logic) stay exactly as it is: by the time
// a card reaches the deck it is an ordinary Trakt-shaped FeedItem.

import { getActiveSkipKeys, getWatchedKeys, getWatchlistKeys, keyOf, type MediaType } from './db'
import { interleave, preloadImages, type CardFeed } from './feed'
import {
  discoverServer,
  getSections,
  getUnwatchedItems,
  type PlexCandidate,
  type PlexSection,
  type PlexServer,
} from './plex'
import type { MediaFilter } from './settings'
import { lookupByExternalId, type ExternalIdProvider, type FeedItem } from './trakt'

const REFILL_THRESHOLD = 5
/** Trakt lookups issued at once while topping the buffer up. */
const RESOLVE_BATCH = 8

/** Which id namespaces to try, best-supported first for each media type. */
const PROVIDERS: Record<MediaType, ExternalIdProvider[]> = {
  movie: ['imdb', 'tmdb'],
  show: ['tvdb', 'imdb', 'tmdb'],
}

export interface PlexFeedStatus {
  server: string
  /** Every movie/show section on the server, for the library picker. */
  sections: PlexSection[]
  /** Sections actually being read this session. */
  activeSections: PlexSection[]
  /** Unwatched Plex items queued up for review. */
  candidates: number
  /** Items whose GUIDs Trakt couldn't resolve; skipped rather than shown. */
  unmatched: number
}

export class PlexFeed implements CardFeed {
  private buffer: FeedItem[] = []
  private candidates: PlexCandidate[] = []
  private cursor = 0
  private seen = new Set<string>()
  private excluded = new Set<string>()
  private resolving: Promise<void> | null = null

  private server: PlexServer | null = null
  private sections: PlexSection[] = []
  private activeSections: PlexSection[] = []
  private unmatched = 0

  /** @param sectionKeys library sections to read; empty means "all of them". */
  constructor(
    private filter: MediaFilter,
    private sectionKeys: string[],
    private token: string,
  ) {}

  async init() {
    const [watched, watchlist, skips] = await Promise.all([
      getWatchedKeys(),
      getWatchlistKeys(),
      getActiveSkipKeys(Date.now()),
    ])
    this.excluded = new Set([...watched, ...watchlist, ...skips])

    this.server = await discoverServer(this.token)
    this.sections = await getSections(this.server)

    const types = this.types()
    this.activeSections = this.sections.filter(
      (s) => types.includes(s.type) && (this.sectionKeys.length === 0 || this.sectionKeys.includes(s.key)),
    )

    const lists = await Promise.all(
      this.activeSections.map((section) => getUnwatchedItems(this.server!, section)),
    )
    // Interleave sections so a movie library doesn't have to be exhausted
    // before a show library gets a look in.
    this.candidates = interleave(lists)

    await this.ensureFilled()
  }

  status(): PlexFeedStatus {
    return {
      server: this.server?.name ?? '',
      sections: this.sections,
      activeSections: this.activeSections,
      candidates: Math.max(0, this.candidates.length - this.cursor),
      unmatched: this.unmatched,
    }
  }

  async next(): Promise<FeedItem | null> {
    if (this.buffer.length <= REFILL_THRESHOLD) void this.ensureFilled()
    while (this.buffer.length === 0 && !this.exhausted()) {
      await this.ensureFilled()
    }
    return this.buffer.shift() ?? null
  }

  peek(n: number): FeedItem[] {
    return this.buffer.slice(0, n)
  }

  pushFront(item: FeedItem) {
    this.buffer.unshift(item)
  }

  exclude(type: MediaType, traktId: number) {
    this.excluded.add(keyOf(type, traktId))
  }

  unexclude(type: MediaType, traktId: number) {
    this.excluded.delete(keyOf(type, traktId))
  }

  private types(): MediaType[] {
    const t: MediaType[] = []
    if (this.filter === 'movies' || this.filter === 'both') t.push('movie')
    if (this.filter === 'shows' || this.filter === 'both') t.push('show')
    return t
  }

  private exhausted(): boolean {
    return this.cursor >= this.candidates.length
  }

  private ensureFilled(): Promise<void> {
    if (this.resolving) return this.resolving
    this.resolving = this.fill().finally(() => {
      this.resolving = null
    })
    return this.resolving
  }

  /**
   * Walk the candidate list resolving batches until the buffer is topped up.
   * Loops rather than resolving once, because a batch can easily contribute
   * nothing: unmatched items and already-excluded ones both fall out here.
   */
  private async fill(): Promise<void> {
    while (this.buffer.length <= REFILL_THRESHOLD && !this.exhausted()) {
      const batch = this.candidates.slice(this.cursor, this.cursor + RESOLVE_BATCH)
      this.cursor += batch.length

      const resolved = await Promise.all(batch.map((candidate) => this.resolve(candidate)))
      for (const item of resolved) {
        if (!item) continue
        const key = keyOf(item.type, item.media.ids.trakt)
        if (this.seen.has(key) || this.excluded.has(key)) continue
        this.seen.add(key)
        this.buffer.push(item)
        preloadImages(item)
      }
    }
  }

  /** Try each id namespace the item carries until Trakt recognises one. */
  private async resolve(candidate: PlexCandidate): Promise<FeedItem | null> {
    for (const provider of PROVIDERS[candidate.type]) {
      const id = candidate.guids[provider]
      if (!id) continue
      try {
        const item = await lookupByExternalId(provider, id, candidate.type)
        if (item) return item
      } catch (e) {
        // A transient lookup failure shouldn't sink the whole refill; the item
        // is simply not offered this session.
        console.error('Trakt lookup failed for', candidate.title, e)
      }
    }
    this.unmatched++
    return null
  }
}
