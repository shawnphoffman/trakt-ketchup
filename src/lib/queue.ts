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
  keysFor,
  notFoundCount,
  type FeedItem,
  type HistoryPayload,
  type SyncResponse,
  type WatchedAt,
  type WriteOpts,
} from './trakt'

const MAX_BATCH = 25
const DEBOUNCE_MS = 5000

export type QueueAction = 'history' | 'watchlist'

interface PendingItem {
  item: FeedItem
  action: QueueAction
  mode: WatchedAt
  /**
   * The exact body to send, resolved as soon as the item is enqueued rather
   * than at flush time. Building it can require a network call (ongoing shows
   * need their aired-episode list), and doing that during page unload meant the
   * flush never got as far as issuing the write. By flush time this is almost
   * always already settled.
   */
  payload: Promise<HistoryPayload>
}

export class WatchedQueue {
  private pending: PendingItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  /** Current backoff between retries of a failed flush; 0 when healthy. */
  private retryDelay = 0

  /** @param onChange notified with the pending count whenever it changes
   *  (enqueue, undo, flush, or a failed flush re-queue) so the UI can track it. */
  constructor(private onChange?: (pendingCount: number) => void) {
    // Flush whatever is buffered before the tab goes away. These use keepalive
    // so the request survives the page being torn down. `pagehide` is included
    // because mobile browsers frequently skip `beforeunload` entirely.
    const flushOnExit = () => void this.flush({ keepalive: true }).catch(() => {})
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnExit()
    })
    window.addEventListener('pagehide', flushOnExit)
    window.addEventListener('beforeunload', flushOnExit)
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
    const keys = keysFor(item)
    if (action === 'history') await markWatchedLocal(item.type, keys)
    else await markWatchlistLocal(item.type, keys)

    // Start building the payload now, but don't await it: the tap should advance
    // the card immediately, and the flush is at least a debounce away.
    const payload =
      action === 'history' ? buildHistoryPayload(item, mode) : Promise.resolve(buildWatchlistPayload(item))
    payload.catch(() => {}) // settled again in send(); avoids an unhandled rejection

    this.pending.push({ item, action, mode, payload })
    this.emit()

    // Failures are logged and re-queued inside send(); swallowing the rejection
    // here just stops these fire-and-forget flushes from surfacing as uncaught
    // promise errors in the console.
    if (this.pending.length >= MAX_BATCH) {
      void this.flush().catch(() => {})
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush().catch(() => {}), DEBOUNCE_MS)
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
    const keys = new Set(keysFor(item))
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      if (p.item.type === item.type && keysFor(p.item).some((k) => keys.has(k))) {
        this.pending.splice(i, 1)
        this.emit()
        return true
      }
    }
    return false
  }

  async flush(opts: WriteOpts = {}): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.inFlight) return this.inFlight
    if (this.pending.length === 0) return

    const batch = this.pending
    this.pending = []
    this.emit() // optimistically clear the count; restored below if the send fails

    this.inFlight = this.send(batch, opts).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async send(batch: PendingItem[], opts: WriteOpts) {
    // Each action is its own Trakt request. Send them independently so a failure
    // in one doesn't re-queue (and thus duplicate) the items that already landed.
    const history = batch.filter((b) => b.action === 'history')
    const watchlist = batch.filter((b) => b.action === 'watchlist')
    const groups: Array<{ items: PendingItem[]; run: () => Promise<void> }> = [
      {
        items: history,
        run: async () => {
          const payloads = await Promise.all(history.map((b) => b.payload))
          assertAccepted(await addToHistory(mergePayloads(payloads), opts), 'history')
        },
      },
      {
        items: watchlist,
        run: async () => {
          const payloads = await Promise.all(watchlist.map((b) => b.payload))
          assertAccepted(await addToWatchlist(mergePayloads(payloads), opts), 'watchlist')
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
      this.scheduleRetry()
      throw firstError
    }
    this.retryDelay = 0
  }

  /**
   * Retry a failed flush on its own timer.
   *
   * Without this, a re-queued batch only gets another attempt when the user
   * happens to mark something else — so if they stop tapping (or the failure
   * was a rate limit that cleared seconds later) the marks sit unsent until the
   * page closes. Backing off matters as much as retrying: the most likely
   * cause is Trakt rate limiting, and retrying hard makes that worse.
   */
  private scheduleRetry() {
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, 60_000) : 5_000
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush().catch(() => {}), this.retryDelay)
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
