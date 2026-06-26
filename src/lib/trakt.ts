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

/**
 * Image URLs returned by Trakt with `extended=images`. Each is an array of
 * protocol-less host/path strings (e.g. "walter-r2.trakt.tv/images/..."), so
 * they must be prefixed with https://. Availability varies by app tier; we
 * fall back to a generated gradient whenever a kind is missing.
 */
export interface TraktImages {
  fanart?: string[]
  poster?: string[]
  logo?: string[]
  clearart?: string[]
  banner?: string[]
  thumb?: string[]
}

export interface TraktMedia {
  title: string
  year: number | null
  ids: TraktIds
  overview?: string
  genres?: string[]
  /** Present on shows with extended=full: "ended" | "returning series" | "canceled" | ... */
  status?: string
  /** Present with extended=images. */
  images?: TraktImages
}

/** A single card in the feed, with image URLs resolved up front. */
export interface FeedItem {
  type: MediaType
  media: TraktMedia
  /** Portrait poster, https-normalized; undefined → use a gradient fallback. */
  poster?: string
  /** Landscape backdrop (fanart) for the ambient background. */
  backdrop?: string
}

/** Take the first usable URL from a Trakt image array and ensure it has a scheme. */
function imageUrl(arr?: string[]): string | undefined {
  const u = arr?.find(Boolean)
  if (!u) return undefined
  return /^https?:\/\//.test(u) ? u : `https://${u}`
}

function toFeedItem(type: MediaType, media: TraktMedia): FeedItem {
  return {
    type,
    media,
    poster: imageUrl(media.images?.poster),
    backdrop: imageUrl(media.images?.fanart),
  }
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

// Where feed cards come from. "Most watched, all time" is the highest-yield
// source for backfilling, but always returns the same list, so we offer other
// wells and a "mix" that blends them for variety.
export type FeedSource = 'mix' | 'watched' | 'popular' | 'trending' | 'recent' | 'classics'
export type SingleSource = Exclude<FeedSource, 'mix'>

// Upper bound (exclusive) for what counts as a "classic". Trakt's `years`
// filter takes a range; we ask for the most-watched titles released before
// this year so the classics well is high-yield old stuff, not obscure ones.
const CLASSICS_YEARS = '1920-1999'

// `wrapped` sources return rows like { movie } / { show }; `popular` returns
// bare media objects. All support extended=full,images and ?page=&limit=.
// `query` adds extra filters (e.g. a `years` range) to the list request.
const SOURCE_ENDPOINT: Record<SingleSource, { path: string; wrapped: boolean; query?: string }> = {
  watched: { path: 'watched/all', wrapped: true },
  popular: { path: 'popular', wrapped: false },
  trending: { path: 'trending', wrapped: true },
  recent: { path: 'watched/monthly', wrapped: true },
  // Most-watched older titles: same high-yield well, scoped to pre-2000.
  classics: { path: 'watched/all', wrapped: true, query: `years=${CLASSICS_YEARS}` },
}

/** Sources blended (round-robin) when the user picks "mix". */
export const MIX_SOURCES: SingleSource[] = ['watched', 'popular', 'trending', 'recent', 'classics']

export async function getFeedPage(
  source: SingleSource,
  type: MediaType,
  page: number,
  limit = 20,
): Promise<FeedItem[]> {
  const endpoint = SOURCE_ENDPOINT[source]
  const plural = type === 'movie' ? 'movies' : 'shows'
  const extra = endpoint.query ? `&${endpoint.query}` : ''
  const rows = await api<unknown[]>(`/${plural}/${endpoint.path}?extended=full,images&page=${page}&limit=${limit}${extra}`)
  return rows.map((row) => {
    const media = (endpoint.wrapped ? (row as Record<MediaType, TraktMedia>)[type] : row) as TraktMedia
    return toFeedItem(type, media)
  })
}

// ---- watched history + watchlist (for the exclusion cache) -----------------

// Rows from /sync/{watched,watchlist}/{movies,shows} are wrapped per type.
type MovieRow = { movie: TraktMedia }
type ShowRow = { show: TraktMedia }

export async function getWatchedMovieIds(): Promise<number[]> {
  const rows = await api<MovieRow[]>(`/sync/watched/movies`)
  return rows.map((r) => r.movie.ids.trakt)
}

export async function getWatchedShowIds(): Promise<number[]> {
  const rows = await api<ShowRow[]>(`/sync/watched/shows`)
  return rows.map((r) => r.show.ids.trakt)
}

export async function getWatchlistMovieIds(): Promise<number[]> {
  const rows = await api<MovieRow[]>(`/sync/watchlist/movies`)
  return rows.map((r) => r.movie.ids.trakt)
}

export async function getWatchlistShowIds(): Promise<number[]> {
  const rows = await api<ShowRow[]>(`/sync/watchlist/shows`)
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

/**
 * Trakt's sync response. A 2xx does NOT mean the items were accepted: anything
 * whose ids didn't resolve is returned (silently) under `not_found`, so callers
 * must inspect this body rather than trust the HTTP status alone.
 */
export interface SyncResponse {
  added?: Record<string, number>
  updated?: Record<string, number>
  existing?: Record<string, number>
  not_found?: Record<string, unknown[]>
}

/** Total number of items Trakt reported under `not_found` across all buckets. */
export function notFoundCount(res: SyncResponse): number {
  return Object.values(res.not_found ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0)
}

export async function addToHistory(payload: HistoryPayload): Promise<SyncResponse> {
  return api<SyncResponse>(`/sync/history`, { method: 'POST', body: JSON.stringify(payload) })
}

/**
 * Remove a previously-added item from Trakt history. Used by go-back when the
 * watched mark was already flushed (removal is by ids/seasons, watched_at is
 * irrelevant, but we reuse buildHistoryPayload to mirror exactly what was sent).
 */
export async function removeFromHistory(item: FeedItem, mode: WatchedAt): Promise<void> {
  const payload = await buildHistoryPayload(item, mode)
  await api(`/sync/history/remove`, { method: 'POST', body: JSON.stringify(payload) })
}

// ---- watchlist -------------------------------------------------------------

/** Whole movie/show: the watchlist has no date or season granularity. The
 *  shape reuses HistoryPayload (watched_at is optional) so batches can merge. */
export function buildWatchlistPayload(item: FeedItem): HistoryPayload {
  return item.type === 'movie' ? { movies: [{ ids: item.media.ids }] } : { shows: [{ ids: item.media.ids }] }
}

export async function addToWatchlist(payload: HistoryPayload): Promise<SyncResponse> {
  return api<SyncResponse>(`/sync/watchlist`, { method: 'POST', body: JSON.stringify(payload) })
}

export async function removeFromWatchlist(item: FeedItem): Promise<void> {
  await api(`/sync/watchlist/remove`, { method: 'POST', body: JSON.stringify(buildWatchlistPayload(item)) })
}
