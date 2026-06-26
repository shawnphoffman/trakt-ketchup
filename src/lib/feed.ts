// Feed engine: keeps a buffer of upcoming cards filled by prefetching pages
// from Trakt, filtering out anything already watched, watchlisted, or currently
// suppressed by the skip-memory. Designed so the UI never waits.
//
// A single source (e.g. "popular") pages straight through. The "mix" source
// round-robins across several wells (MIX_SOURCES) so the feed surfaces
// different kinds of titles instead of the same all-time list every session.

import { getActiveSkipKeys, getWatchedKeys, getWatchlistKeys, keyOf, type MediaType } from './db'
import { getFeedPage, MIX_SOURCES, type FeedItem, type FeedSource, type SingleSource } from './trakt'
import type { MediaFilter } from './settings'

const REFILL_THRESHOLD = 5 // refetch when fewer than this remain
const PAGE_SIZE = 20

export class Feed {
  private buffer: FeedItem[] = []
  private seen = new Set<string>() // dedupe across pages/sources within a session
  private excluded = new Set<string>() // watched + watchlisted + active skips
  private pages = new Map<string, number>() // "source:type" -> next page
  private exhausted = new Set<string>() // "source:type" that ran out
  private rotation = 0 // round-robin cursor across sources (for "mix")
  private fetching: Promise<void> | null = null

  constructor(
    private filter: MediaFilter,
    private source: FeedSource,
  ) {}

  /** Load the exclusion set before first use. */
  async init() {
    const [watched, watchlist, skips] = await Promise.all([
      getWatchedKeys(),
      getWatchlistKeys(),
      getActiveSkipKeys(Date.now()),
    ])
    this.excluded = new Set([...watched, ...watchlist, ...skips])
    await this.ensureFilled()
  }

  /** Optimistically suppress a key so it never reappears this session. */
  exclude(type: MediaType, traktId: number) {
    this.excluded.add(keyOf(type, traktId))
  }

  /** Take the next card, kicking off a background refill when running low. */
  async next(): Promise<FeedItem | null> {
    if (this.buffer.length <= REFILL_THRESHOLD) void this.ensureFilled()
    while (this.buffer.length === 0 && !this.allExhausted()) {
      await this.ensureFilled()
    }
    return this.buffer.shift() ?? null
  }

  /** Peek ahead without consuming (for prefetching images, etc.). */
  peek(n: number): FeedItem[] {
    return this.buffer.slice(0, n)
  }

  /** Put an item back at the front of the buffer (used by go-back). */
  pushFront(item: FeedItem) {
    this.buffer.unshift(item)
  }

  /** Reverse an optimistic exclusion so an item can be acted on again. */
  unexclude(type: MediaType, traktId: number) {
    this.excluded.delete(keyOf(type, traktId))
  }

  private sources(): SingleSource[] {
    return this.source === 'mix' ? MIX_SOURCES : [this.source]
  }

  private types(): MediaType[] {
    const t: MediaType[] = []
    if (this.filter === 'movies' || this.filter === 'both') t.push('movie')
    if (this.filter === 'shows' || this.filter === 'both') t.push('show')
    return t
  }

  private comboKey(source: SingleSource, type: MediaType): string {
    return `${source}:${type}`
  }

  private allExhausted(): boolean {
    for (const source of this.sources()) {
      for (const type of this.types()) {
        if (!this.exhausted.has(this.comboKey(source, type))) return false
      }
    }
    return true
  }

  private ensureFilled(): Promise<void> {
    if (this.fetching) return this.fetching
    this.fetching = this.fill().finally(() => {
      this.fetching = null
    })
    return this.fetching
  }

  private async fill(): Promise<void> {
    if (this.buffer.length > REFILL_THRESHOLD || this.allExhausted()) return

    // Pick the next source (round-robin) that still has an un-exhausted type.
    const sources = this.sources()
    const types = this.types()
    let chosen: SingleSource | null = null
    for (let i = 0; i < sources.length; i++) {
      const source = sources[(this.rotation + i) % sources.length]
      if (types.some((type) => !this.exhausted.has(this.comboKey(source, type)))) {
        chosen = source
        this.rotation = (this.rotation + i + 1) % sources.length
        break
      }
    }
    if (!chosen) return

    // Fetch every wanted (non-exhausted) media type for that source in parallel.
    const combos = types
      .filter((type) => !this.exhausted.has(this.comboKey(chosen!, type)))
      .map((type) => ({ type, key: this.comboKey(chosen!, type), page: this.pages.get(this.comboKey(chosen!, type)) ?? 1 }))
    const results = await Promise.all(combos.map((c) => getFeedPage(chosen!, c.type, c.page, PAGE_SIZE)))

    const lists: FeedItem[][] = []
    results.forEach((items, idx) => {
      const combo = combos[idx]
      if (items.length < PAGE_SIZE) this.exhausted.add(combo.key)
      this.pages.set(combo.key, combo.page + 1)
      lists.push(items)
    })

    // Interleave movie/show results so the feed feels mixed, then filter.
    for (const item of interleave(lists)) {
      const key = keyOf(item.type, item.media.ids.trakt)
      if (this.seen.has(key) || this.excluded.has(key)) continue
      this.seen.add(key)
      this.buffer.push(item)
      // Warm the browser cache for upcoming art so cards don't flash on advance.
      preloadImages(item)
    }
  }
}

const preloaded = new Set<string>()

/** Kick off background image loads (held in cache) for an upcoming card. */
function preloadImages(item: FeedItem) {
  for (const url of [item.backdrop, item.poster]) {
    if (!url || preloaded.has(url)) continue
    preloaded.add(url)
    const img = new Image()
    img.src = url
  }
}

function interleave(lists: FeedItem[][]): FeedItem[] {
  const out: FeedItem[] = []
  const max = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i])
    }
  }
  return out
}
