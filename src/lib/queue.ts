// Batched write queue for marking items watched. Instead of hammering
// /sync/history once per tap, we buffer items and flush them together
// (on a debounce, when the batch is large, or when the page is hidden).

import { markWatchedLocal } from './db'
import { addToHistory, buildHistoryPayload, type FeedItem, type HistoryPayload, type WatchedAt } from './trakt'

const MAX_BATCH = 25
const DEBOUNCE_MS = 2500

export class WatchedQueue {
  private pending: { item: FeedItem; mode: WatchedAt }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null

  constructor() {
    // Flush whatever is buffered before the tab goes away.
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush()
    })
    window.addEventListener('beforeunload', () => void this.flush())
  }

  /**
   * Enqueue an item to be marked watched. Updates the local cache immediately
   * (optimistic) so the feed won't resurface it even before the flush lands.
   */
  async enqueue(item: FeedItem, mode: WatchedAt) {
    await markWatchedLocal(item.type, item.media.ids.trakt)
    this.pending.push({ item, mode })

    if (this.pending.length >= MAX_BATCH) {
      void this.flush()
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS)
  }

  get pendingCount() {
    return this.pending.length
  }

  /**
   * Remove the most recent still-pending enqueue of an item (for go-back).
   * Returns true if it was found before being flushed; false means it has
   * already been sent to Trakt and must be undone via the API instead.
   */
  unqueue(item: FeedItem): boolean {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      if (p.item.type === item.type && p.item.media.ids.trakt === item.media.ids.trakt) {
        this.pending.splice(i, 1)
        return true
      }
    }
    return false
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.inFlight) return this.inFlight
    if (this.pending.length === 0) return

    const batch = this.pending
    this.pending = []

    this.inFlight = this.send(batch).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async send(batch: { item: FeedItem; mode: WatchedAt }[]) {
    // Build per-item payloads (ongoing shows need an async season fetch),
    // then merge into a single /sync/history request.
    const payloads = await Promise.all(batch.map((b) => buildHistoryPayload(b.item, b.mode)))
    const merged = mergePayloads(payloads)
    try {
      await addToHistory(merged)
    } catch (err) {
      // Re-queue on failure so the items aren't silently lost.
      console.error('Batch flush failed, re-queueing', err)
      this.pending.unshift(...batch)
      throw err
    }
  }
}

function mergePayloads(payloads: HistoryPayload[]): HistoryPayload {
  const merged: HistoryPayload = {}
  for (const p of payloads) {
    if (p.movies?.length) (merged.movies ??= []).push(...p.movies)
    if (p.shows?.length) (merged.shows ??= []).push(...p.shows)
  }
  return merged
}
