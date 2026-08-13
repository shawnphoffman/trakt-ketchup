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
  getGuidsForItems,
  getSections,
  getUnwatchedItems,
  hasAnyGuid,
  type PlexCandidate,
  type PlexSection,
  type PlexServer,
} from './plex'
import type { MediaFilter } from './settings'
import { lookupByExternalId, type ExternalIdProvider, type FeedItem } from './trakt'

const REFILL_THRESHOLD = 5
/** Candidates resolved together. Trakt calls are throttled globally, so a
 *  bigger fan-out here would only queue up behind the same gate. */
const RESOLVE_BATCH = 4
/** Batches per fill() pass. Bounding this is what keeps a library that resolves
 *  nothing from being consumed in one uninterruptible run; next() will call
 *  again, but the UI gets to breathe in between. */
const MAX_BATCHES_PER_FILL = 4
/** Consecutive lookup *errors* before we stop and report rather than churn. */
const FAILURE_LIMIT = 8

type ResolveResult =
  | { item: FeedItem; reason?: undefined }
  | { item?: undefined; reason: 'no-ids' | 'not-found' | 'error' }

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
  /** Items Trakt has no entry for. A real, permanent verdict about the item. */
  unmatched: number
  /** Items carrying no IMDb/TMDB/TVDB id at all, so nothing to look up. */
  missingIds: number
  /** Set when resolution was abandoned; the library was NOT fully reviewed. */
  error: string | null
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
  private missingIds = 0
  private failureStreak = 0
  private lastError: string | null = null
  private error: string | null = null
  /** Memoized Trakt lookups: box sets and duplicates resolve to the same ids. */
  private lookups = new Map<string, FeedItem | null>()

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
      missingIds: this.missingIds,
      error: this.error,
    }
  }

  async next(): Promise<FeedItem | null> {
    if (this.buffer.length <= REFILL_THRESHOLD) void this.ensureFilled()

    // `!this.error` and the progress check are both load-bearing. fill() returns
    // immediately once it has given up, and it stops early to yield to the UI,
    // so without them this becomes a tight loop that never awaits anything real
    // and pins the tab at 100% CPU.
    while (this.buffer.length === 0 && !this.exhausted() && !this.error) {
      const before = this.cursor
      await this.ensureFilled()
      if (this.cursor === before) break // no progress: stop rather than spin
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
   *
   * The failure guard matters more than it looks. Without it, one systematic
   * problem (rate limiting, an expired token, a library whose items carry no
   * external ids) makes every resolve return nothing, the loop drains the
   * entire library in one pass, and the user is told they're all caught up
   * while their whole library was silently discarded. Bailing out and
   * surfacing the reason is always better than a cheerful empty deck.
   */
  private async fill(): Promise<void> {
    let passes = 0
    while (this.buffer.length <= REFILL_THRESHOLD && !this.exhausted() && !this.error) {
      if (passes++ >= MAX_BATCHES_PER_FILL) return
      const batch = this.candidates.slice(this.cursor, this.cursor + RESOLVE_BATCH)
      this.cursor += batch.length

      await this.backfillGuids(batch)
      const results = await Promise.all(batch.map((candidate) => this.resolve(candidate)))

      let failures = 0
      for (const result of results) {
        if (result.item) {
          this.failureStreak = 0
          const key = keyOf(result.item.type, result.item.media.ids.trakt)
          if (this.seen.has(key) || this.excluded.has(key)) continue
          this.seen.add(key)
          this.buffer.push(result.item)
          preloadImages(result.item)
          continue
        }
        if (result.reason === 'error') failures++
        else if (result.reason === 'no-ids') this.missingIds++
        else this.unmatched++
      }

      // Only lookup *errors* count toward the streak. An item Trakt genuinely
      // doesn't have is a normal outcome and must not trip the guard.
      this.failureStreak = failures > 0 ? this.failureStreak + failures : 0
      if (this.failureStreak >= FAILURE_LIMIT) {
        this.error =
          this.lastError ?? 'Trakt lookups keep failing, so the rest of the library was left alone.'
        return
      }
    }
  }

  /**
   * Resolve one Plex item to a Trakt title.
   *
   * `no-ids` and `not-found` are permanent verdicts about the item;
   * `error` means the question couldn't be asked and says nothing about
   * whether Trakt has it. Keeping them apart is what lets the caller tell a
   * genuinely unmatchable library from a broken connection.
   */
  /**
   * Fill in external ids for any candidate whose section listing arrived
   * without them, in one request for the whole batch. Plex accepts a
   * comma-separated set of rating keys, so this costs one round trip per batch
   * rather than one per item.
   */
  private async backfillGuids(batch: PlexCandidate[]): Promise<void> {
    const missing = batch.filter((c) => !hasAnyGuid(c.guids))
    if (missing.length === 0 || !this.server) return

    try {
      const found = await getGuidsForItems(
        this.server,
        missing.map((c) => c.ratingKey),
      )
      for (const candidate of missing) {
        candidate.guids = found.get(candidate.ratingKey) ?? candidate.guids
      }
    } catch (e) {
      // Leaves them without ids; they fall out as 'no-ids' below rather than
      // being reported as a hard failure of the whole scan.
      console.error('Plex metadata backfill failed', e)
    }
  }

  private async resolve(candidate: PlexCandidate): Promise<ResolveResult> {
    const guids = candidate.guids
    if (!hasAnyGuid(guids)) return { reason: 'no-ids' }

    for (const provider of PROVIDERS[candidate.type]) {
      const id = guids[provider]
      if (!id) continue

      const cacheKey = `${provider}:${id}:${candidate.type}`
      const cached = this.lookups.get(cacheKey)
      if (cached !== undefined) {
        if (cached) return { item: cached }
        continue
      }

      try {
        const item = await lookupByExternalId(provider, id, candidate.type)
        this.lookups.set(cacheKey, item)
        if (item) return { item }
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e)
        console.error('Trakt lookup failed for', candidate.title, e)
        return { reason: 'error' }
      }
    }

    return { reason: 'not-found' }
  }
}
