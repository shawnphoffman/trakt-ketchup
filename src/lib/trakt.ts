// Direct browser -> Trakt API client. Works in the browser because the Trakt
// app's "JavaScript (CORS) origins" are configured to include this origin.
// The only call that does NOT go through here is the token exchange (see auth.ts).

import { getValidAccessToken } from './auth'
import type { MediaType } from './db'

const API = 'https://api.trakt.tv'
const CLIENT_ID = import.meta.env.VITE_TRAKT_CLIENT_ID as string

export interface TraktIds {
  trakt: number
  slug?: string
  tmdb?: number
  imdb?: string
}

export interface TraktMedia {
  title: string
  year: number | null
  ids: TraktIds
  overview?: string
  genres?: string[]
  /** Present on shows with extended=full: "ended" | "returning series" | "canceled" | ... */
  status?: string
}

/** A single card in the feed. */
export interface FeedItem {
  type: MediaType
  media: TraktMedia
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getValidAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(await authHeaders()), ...(init?.headers ?? {}) } })
  if (!res.ok) throw new Error(`Trakt ${path} -> ${res.status}`)
  return (await res.json()) as T
}

// ---- discovery feed --------------------------------------------------------

// "Most watched, all time" is the highest-yield source for backfilling a
// watch history: these are the titles a user is most likely to have seen.
// Returned items are wrapped: { watcher_count, movie | show }.

type WatchedMovieRow = { movie: TraktMedia }
type WatchedShowRow = { show: TraktMedia }

export async function getMostWatchedMovies(page: number, limit = 20): Promise<FeedItem[]> {
  const rows = await api<WatchedMovieRow[]>(`/movies/watched/all?extended=full&page=${page}&limit=${limit}`)
  return rows.map((r) => ({ type: 'movie' as const, media: r.movie }))
}

export async function getMostWatchedShows(page: number, limit = 20): Promise<FeedItem[]> {
  const rows = await api<WatchedShowRow[]>(`/shows/watched/all?extended=full&page=${page}&limit=${limit}`)
  return rows.map((r) => ({ type: 'show' as const, media: r.show }))
}

// ---- watched history (for the exclusion cache) -----------------------------

export async function getWatchedMovieIds(): Promise<number[]> {
  const rows = await api<WatchedMovieRow[]>(`/sync/watched/movies`)
  return rows.map((r) => r.movie.ids.trakt)
}

export async function getWatchedShowIds(): Promise<number[]> {
  const rows = await api<WatchedShowRow[]>(`/sync/watched/shows`)
  return rows.map((r) => r.show.ids.trakt)
}

// ---- marking watched -------------------------------------------------------

export type WatchedAt = 'released' | 'unknown'

// Trakt represents a "watched, unknown date" entry with the Unix epoch, which
// its UI renders as "unknown" (history shows the year as 1969/1970). Sending
// this sentinel is how we mark watched without committing to a real date.
const UNKNOWN_DATE = '1970-01-01T00:00:00.000Z'

interface SeasonPayload {
  number: number
  episodes?: { number: number }[]
}

interface HistoryShow {
  ids: TraktIds
  watched_at?: string
  seasons?: SeasonPayload[]
}

export interface HistoryPayload {
  movies?: { ids: TraktIds; watched_at?: string }[]
  shows?: HistoryShow[]
}

/**
 * Translate our WatchMode into a watched_at value. We ALWAYS send the field
 * explicitly so Trakt never falls back to stamping the current time.
 * - "released": Trakt backfills the item's own release date.
 * - "unknown": the epoch sentinel, which Trakt treats as "unknown date".
 */
function stampFor(mode: WatchedAt): { watched_at: string } {
  return { watched_at: mode === 'released' ? 'released' : UNKNOWN_DATE }
}

const ENDED = new Set(['ended', 'canceled'])

/**
 * Build a /sync/history payload for one feed item.
 * - Movie: the movie.
 * - Completed show (ended/canceled): the whole show.
 * - Ongoing show: only aired seasons/episodes (fetched on demand).
 */
export async function buildHistoryPayload(item: FeedItem, mode: WatchedAt): Promise<HistoryPayload> {
  if (item.type === 'movie') {
    return { movies: [{ ids: item.media.ids, ...stampFor(mode) }] }
  }

  const ended = item.media.status ? ENDED.has(item.media.status) : false
  if (ended) {
    return { shows: [{ ids: item.media.ids, ...stampFor(mode) }] }
  }

  // Ongoing: send only aired episodes.
  const seasons = await getAiredSeasons(item.media.ids.trakt)
  return { shows: [{ ids: item.media.ids, ...stampFor(mode), seasons }] }
}

type SeasonSummary = {
  number: number
  episodes: { number: number; first_aired: string | null }[]
}

async function getAiredSeasons(showId: number): Promise<SeasonPayload[]> {
  const seasons = await api<SeasonSummary[]>(`/shows/${showId}/seasons?extended=episodes`)
  const nowIso = new Date().toISOString()
  return seasons
    .filter((s) => s.number > 0) // skip specials (season 0)
    .map((s) => ({
      number: s.number,
      episodes: s.episodes.filter((e) => e.first_aired && e.first_aired <= nowIso).map((e) => ({ number: e.number })),
    }))
    .filter((s) => (s.episodes?.length ?? 0) > 0)
}

export async function addToHistory(payload: HistoryPayload): Promise<void> {
  await api(`/sync/history`, { method: 'POST', body: JSON.stringify(payload) })
}
