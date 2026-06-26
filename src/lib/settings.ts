// User settings, persisted in localStorage (small, synchronous, fine here).

import type { FeedSource } from './trakt'

export type { FeedSource }

// 'unknown' => Trakt's "watched, unknown date" state (stored as the Unix
// epoch sentinel). 'released' => backfill the title's own release date.
// We NEVER mark something watched as "now".
export type WatchMode = 'unknown' | 'released'
export type MediaFilter = 'movies' | 'shows' | 'both'

export interface Settings {
  /** How to stamp watched_at when marking. */
  watchMode: WatchMode
  /** Which media types the feed pulls. */
  filter: MediaFilter
  /** Which well the feed pulls from ("mix" blends several for variety). */
  source: FeedSource
}

const STORAGE_KEY = 'trakt.settings'

const DEFAULTS: Settings = {
  watchMode: 'unknown',
  filter: 'both',
  source: 'mix',
}

export function loadSettings(): Settings {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}
