// Feed engine for the /plex page: the same one-card-at-a-time deck as the Trakt
// feed, but the well is the user's own Plex libraries instead of Trakt's
// popularity charts.
//
// Shape of the pipeline:
//   1. discover the server and list the selected sections
//   2. pull everything Plex does NOT consider watched (that whole set is the
//      question: "you own it and never played it here, but did you see it?")
//   3. drop anything already in Trakt history/watchlist or under skip-memory
//   4. show it, using Plex's own title, synopsis, and artwork
//
// Note what is NOT here: any call to Trakt. An earlier version resolved every
// candidate to its Trakt entry before showing it, which cost one API call per
// title and rate-limited the app into uselessness on a library of any size.
// Nothing needs it — Trakt accepts IMDb/TMDB/TVDB ids directly when marking,
// and the caches match on those ids too (see identityKeys in db.ts). The only
// Trakt calls the Plex deck makes now happen when the user actually marks a
// show, which is a far smaller number than the titles they scroll past.

import {
  getActiveSkipKeys,
  getWatchedKeys,
  getWatchlistKeys,
  identityKeys,
  type MediaType,
} from './db'
import { interleave, type CardFeed } from './feed'
import {
  discoverServer,
  getGuidsForItems,
  getImageUrl,
  getSections,
  getUnwatchedItems,
  hasAnyGuid,
  type PlexCandidate,
  type PlexSection,
  type PlexServer,
} from './plex'
import type { MediaFilter } from './settings'
import type { FeedItem } from './trakt'

const REFILL_THRESHOLD = 5
/** Candidates prepared per pass. Only Plex is contacted here (for artwork and
 *  the occasional id backfill), so this is bounded by politeness to the user's
 *  own server rather than by any third-party rate limit. */
const PREPARE_BATCH = 6

export interface PlexFeedStatus {
  server: string
  /** Every movie/show section on the server, for the library picker. */
  sections: PlexSection[]
  /** Sections actually being read this session. */
  activeSections: PlexSection[]
  /** Unwatched Plex items still queued up for review. */
  candidates: number
  /** Items carrying no IMDb/TMDB/TVDB id, so Trakt could never identify them. */
  missingIds: number
  /** Set when the scan was abandoned; the library was NOT fully reviewed. */
  error: string | null
}

export class PlexFeed implements CardFeed {
  private buffer: FeedItem[] = []
  private candidates: PlexCandidate[] = []
  private cursor = 0
  private seen = new Set<string>()
  private excluded = new Set<string>()
  private filling: Promise<void> | null = null

  private server: PlexServer | null = null
  private sections: PlexSection[] = []
  private activeSections: PlexSection[] = []
  private missingIds = 0
  private error: string | null = null

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
      missingIds: this.missingIds,
      error: this.error,
    }
  }

  async next(): Promise<FeedItem | null> {
    if (this.buffer.length <= REFILL_THRESHOLD) void this.ensureFilled()

    // The progress check is load-bearing: fill() returns early to yield to the
    // UI, so without it this becomes a tight loop that never awaits anything
    // real and pins the tab at 100% CPU.
    while (this.buffer.length === 0 && !this.exhausted() && !this.error) {
      const before = this.cursor
      await this.ensureFilled()
      if (this.cursor === before) break
    }
    return this.buffer.shift() ?? null
  }

  peek(n: number): FeedItem[] {
    return this.buffer.slice(0, n)
  }

  pushFront(item: FeedItem) {
    this.buffer.unshift(item)
  }

  exclude(keys: string[]) {
    for (const key of keys) this.excluded.add(key)
  }

  unexclude(keys: string[]) {
    for (const key of keys) this.excluded.delete(key)
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
    if (this.filling) return this.filling
    this.filling = this.fill().finally(() => {
      this.filling = null
    })
    return this.filling
  }

  /**
   * Take the next slice of candidates and turn the ones worth showing into
   * cards. Filtering happens before any artwork is fetched, so an
   * already-watched title costs nothing at all.
   */
  private async fill(): Promise<void> {
    while (this.buffer.length <= REFILL_THRESHOLD && !this.exhausted()) {
      const batch = this.candidates.slice(this.cursor, this.cursor + PREPARE_BATCH)
      this.cursor += batch.length

      await this.backfillGuids(batch)

      const showable: PlexCandidate[] = []
      for (const candidate of batch) {
        if (!hasAnyGuid(candidate.guids)) {
          // Nothing Trakt could ever match, so marking it would be a no-op.
          this.missingIds++
          continue
        }
        const keys = identityKeys(candidate.type, toTraktIds(candidate))
        if (keys.some((k) => this.seen.has(k) || this.excluded.has(k))) continue
        for (const key of keys) this.seen.add(key)
        showable.push(candidate)
      }

      const items = await Promise.all(showable.map((c) => this.toFeedItem(c)))
      this.buffer.push(...items)
      return // one pass per call: lets the UI paint between batches
    }
  }

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
      // They fall out as missing ids below rather than failing the whole scan.
      console.error('Plex metadata backfill failed', e)
    }
  }

  /** A card built entirely from Plex's own metadata — no Trakt call. */
  private async toFeedItem(candidate: PlexCandidate): Promise<FeedItem> {
    const [poster, backdrop] = this.server
      ? await Promise.all([
          candidate.thumb ? getImageUrl(this.server, candidate.thumb) : undefined,
          candidate.art ? getImageUrl(this.server, candidate.art) : undefined,
        ])
      : [undefined, undefined]

    return {
      type: candidate.type,
      media: {
        title: candidate.title,
        year: candidate.year,
        ids: toTraktIds(candidate),
        overview: candidate.summary,
        // `status` is deliberately absent: it decides whole-series vs
        // aired-seasons and is fetched at mark time, for marked shows only.
      },
      poster,
      backdrop,
    }
  }
}

/** Plex GUIDs in the shape Trakt's sync endpoints accept verbatim. */
function toTraktIds(candidate: PlexCandidate) {
  const { imdb, tmdb, tvdb } = candidate.guids
  return {
    imdb,
    tmdb: tmdb ? Number(tmdb) : undefined,
    tvdb: tvdb ? Number(tvdb) : undefined,
  }
}
