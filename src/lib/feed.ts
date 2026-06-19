// Feed engine: keeps a buffer of upcoming cards filled by prefetching pages
// from Trakt's "most watched" lists, filtering out anything already watched
// or currently suppressed by the skip-memory. Designed so the UI never waits.

import { getActiveSkipKeys, getWatchedKeys, keyOf, type MediaType } from './db'
import { getMostWatchedMovies, getMostWatchedShows, type FeedItem } from './trakt'
import type { MediaFilter } from './settings'

const REFILL_THRESHOLD = 5 // refetch when fewer than this remain
const PAGE_SIZE = 20

export class Feed {
  private buffer: FeedItem[] = []
  private seen = new Set<string>() // dedupe across pages within a session
  private excluded = new Set<string>() // watched + active skips
  private pages: Record<MediaType, number> = { movie: 1, show: 1 }
  private exhausted: Record<MediaType, boolean> = { movie: false, show: false }
  private fetching: Promise<void> | null = null

  constructor(private filter: MediaFilter) {}

  /** Load the exclusion set (watched cache + active skips) before first use. */
  async init() {
    const [watched, skips] = await Promise.all([getWatchedKeys(), getActiveSkipKeys(Date.now())])
    this.excluded = new Set([...watched, ...skips])
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

  private wantsMovies() {
    return this.filter === 'movies' || this.filter === 'both'
  }
  private wantsShows() {
    return this.filter === 'shows' || this.filter === 'both'
  }

  private allExhausted(): boolean {
    return (!this.wantsMovies() || this.exhausted.movie) && (!this.wantsShows() || this.exhausted.show)
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

    const tasks: Promise<FeedItem[]>[] = []
    if (this.wantsMovies() && !this.exhausted.movie) {
      tasks.push(getMostWatchedMovies(this.pages.movie++, PAGE_SIZE))
    }
    if (this.wantsShows() && !this.exhausted.show) {
      tasks.push(getMostWatchedShows(this.pages.show++, PAGE_SIZE))
    }

    const results = await Promise.all(tasks)
    let movieIdx = 0
    if (this.wantsMovies() && !this.exhausted.movie) {
      if (results[movieIdx].length < PAGE_SIZE) this.exhausted.movie = true
      movieIdx++
    }
    if (this.wantsShows() && !this.exhausted.show) {
      if (results[movieIdx].length < PAGE_SIZE) this.exhausted.show = true
    }

    // Interleave movie/show results so the feed feels mixed, then filter.
    for (const item of interleave(results)) {
      const key = keyOf(item.type, item.media.ids.trakt)
      if (this.seen.has(key) || this.excluded.has(key)) continue
      this.seen.add(key)
      this.buffer.push(item)
    }
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
