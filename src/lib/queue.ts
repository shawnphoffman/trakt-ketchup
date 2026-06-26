// Batched write queue for marking items. Instead of hammering Trakt once per
// tap, we buffer items and flush them together (on a debounce, when the batch
// is large, or when the page is hidden). Handles two actions: marking watched
// (-> /sync/history) and adding to the watchlist (-> /sync/watchlist).

import { markWatchedLocal, markWatchlistLocal } from './db'
import {
  addToHistory,
  addToWatchlist,
  buildHistoryPayload,
  buildWatchlistPayload,
  notFoundCount,
  type FeedItem,
  type HistoryPayload,
  type SyncResponse,
  type WatchedAt,
} from './trakt'

const MAX_BATCH = 25
const DEBOUNCE_MS = 5000

export type QueueAction = 'history' | 'watchlist'

interface PendingItem {
  item: FeedItem
  action: QueueAction
  mode: WatchedAt
}

export class WatchedQueue {
  private pending: PendingItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null

  /** @param onChange notified with the pending count whenever it changes
   *  (enqueue, undo, flush, or a failed flush re-queue) so the UI can track it. */
  constructor(private onChange?: (pendingCount: number) => void) {
    // Flush whatever is buffered before the tab goes away.
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush()
    })
    window.addEventListener('beforeunload', () => void this.flush())
  }

  private emit() {
    this.onChange?.(this.pending.length)
  }

  /**
   * Enqueue an item. Updates the matching local cache immediately (optimistic)
   * so the feed won't resurface it even before the flush lands. `mode` is only
   * used by the history action.
   */
  async enqueue(item: FeedItem, action: QueueAction, mode: WatchedAt) {
    if (action === 'history') await markWatchedLocal(item.type, item.media.ids.trakt)
    else await markWatchlistLocal(item.type, item.media.ids.trakt)
    this.pending.push({ item, action, mode })
    this.emit()

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
        this.emit()
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
    this.emit() // optimistically clear the count; restored below if the send fails

    this.inFlight = this.send(batch).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async send(batch: PendingItem[]) {
    // Each action is its own Trakt request. Send them independently so a failure
    // in one doesn't re-queue (and thus duplicate) the items that already landed.
    const history = batch.filter((b) => b.action === 'history')
    const watchlist = batch.filter((b) => b.action === 'watchlist')
    const groups: Array<{ items: PendingItem[]; run: () => Promise<void> }> = [
      {
        items: history,
        run: async () => {
          const payloads = await Promise.all(history.map((b) => buildHistoryPayload(b.item, b.mode)))
          assertAccepted(await addToHistory(mergePayloads(payloads)), 'history')
        },
      },
      {
        items: watchlist,
        run: async () => {
          assertAccepted(await addToWatchlist(mergePayloads(watchlist.map((b) => buildWatchlistPayload(b.item)))), 'watchlist')
        },
      },
    ]

    const failed: PendingItem[] = []
    let firstError: unknown
    for (const group of groups) {
      if (group.items.length === 0) continue
      try {
        await group.run()
      } catch (err) {
        firstError ??= err
        failed.push(...group.items)
      }
    }

    if (failed.length) {
      // Re-queue only what failed so the items aren't silently lost.
      console.error('Batch flush failed, re-queueing', firstError)
      this.pending.unshift(...failed)
      this.emit()
      throw firstError
    }
  }
}

/**
 * Trakt answers 2xx even when it accepted nothing, listing unresolved items
 * under `not_found`. Treat any such item as a failure so the batch re-queues and
 * the pending count stays visible, rather than silently dropping the mark.
 */
function assertAccepted(res: SyncResponse, label: string) {
  const missing = notFoundCount(res)
  if (missing > 0) {
    throw new Error(`Trakt ${label}: ${missing} item(s) not found (rejected by Trakt)`)
  }
}

export function mergePayloads(payloads: HistoryPayload[]): HistoryPayload {
  const merged: HistoryPayload = {}
  for (const p of payloads) {
    if (p.movies?.length) (merged.movies ??= []).push(...p.movies)
    if (p.shows?.length) (merged.shows ??= []).push(...p.shows)
  }
  return merged
}
