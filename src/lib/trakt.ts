// Direct browser -> Trakt API client. Works in the browser because the Trakt
// app's "JavaScript (CORS) origins" are configured to include this origin.
// The only call that does NOT go through here is the token exchange (see auth.ts).

import { getValidAccessToken } from './auth'
import { identityKeys, type MediaType } from './db'

const API = 'https://api.trakt.tv'
const CLIENT_ID = import.meta.env.VITE_TRAKT_CLIENT_ID as string

/**
 * `trakt` is optional because Plex-sourced cards never carry one: resolving a
 * Plex item to its Trakt entry costs an API call per title, which is what was
 * rate-limiting us. Trakt accepts IMDb/TMDB/TVDB ids directly on both the sync
 * endpoints and the `:id` path parameter, so a Trakt id is never required to
 * act on a title — only to name it internally, which `identityKeys` handles.
 */
export interface TraktIds {
  trakt?: number
  slug?: string
  tmdb?: number
  imdb?: string
  tvdb?: number
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

/** Every cache/skip key this card is known by. One place, so the two decks
 *  agree on identity even though they learn about titles differently. */
export function keysFor(item: FeedItem): string[] {
  return identityKeys(item.type, item.media.ids)
}

/** The id Trakt should be asked about in a `:id` path parameter. Trakt resolves
 *  IMDb ids there as readily as its own, which is what lets a Plex card fetch
 *  show details without ever having been looked up. */
export function pathId(ids: TraktIds): string | null {
  if (ids.trakt !== undefined) return String(ids.trakt)
  if (ids.imdb) return ids.imdb
  return null
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

/**
 * Client-side rate limiting for every Trakt call.
 *
 * Trakt allows roughly 1000 GETs per 5 minutes. Exceeding it is not a soft
 * failure: Trakt's 429 response carries no `Access-Control-Allow-Origin`
 * header, so the browser rejects it as an opaque CORS/NetworkError and the
 * status code is unreadable from JS. Every over-limit request therefore looks
 * like the network died, which is indistinguishable from a real outage and
 * impossible to handle precisely after the fact.
 *
 * So we stay under the limit instead of reacting to it: all calls funnel
 * through one promise chain that spaces them out. Resolving a large Plex
 * library becomes slow rather than broken, which is the right trade since the
 * feed only needs to stay a few cards ahead of the user.
 */
const MIN_CALL_SPACING_MS = 350 // ~2.8/s => ~850 per 5 min, safely under 1000

let throttleChain: Promise<void> = Promise.resolve()
let lastCallAt = 0

function throttle(): Promise<void> {
  throttleChain = throttleChain.then(async () => {
    const wait = lastCallAt + MIN_CALL_SPACING_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
  })
  return throttleChain
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // The unload flush must not queue behind anything; losing the batch is the
  // alternative, and it is a single request.
  if (!init?.keepalive) await throttle()
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

// NOTE: there was a per-title `/search/:provider/:id` lookup here, used to turn
// a Plex item into a Trakt one before showing it. It was removed deliberately.
// At one call per candidate it exhausted Trakt's rate limit on any real
// library, and Trakt's 429 carries no CORS headers, so the failures surfaced as
// opaque network errors that were impossible to handle precisely. Nothing needs
// it: the sync endpoints accept external ids directly, and the caches match on
// them via identityKeys. Please don't reintroduce it.

// ---- watched history + watchlist (for the exclusion cache) -----------------

// Rows from /sync/{watched,watchlist}/{movies,shows} are wrapped per type.
type MovieRow = { movie: TraktMedia }
type ShowRow = { show: TraktMedia }

// These deliberately keep every id Trakt returns, not just the Trakt one. The
// external ids are what let a Plex card be recognised as already-watched
// without a per-title lookup to translate it first.

export async function getWatchedMovieIds(): Promise<TraktIds[]> {
  const rows = await api<MovieRow[]>(`/sync/watched/movies`)
  return rows.map((r) => r.movie.ids)
}

export async function getWatchedShowIds(): Promise<TraktIds[]> {
  // `extended=noseasons` drops the per-season/per-episode breakdown, which is
  // the bulk of this response and which we never read (we only want ids).
  const rows = await api<ShowRow[]>(`/sync/watched/shows?extended=noseasons`)
  return rows.map((r) => r.show.ids)
}

export async function getWatchlistMovieIds(): Promise<TraktIds[]> {
  const rows = await api<MovieRow[]>(`/sync/watchlist/movies`)
  return rows.map((r) => r.movie.ids)
}

export async function getWatchlistShowIds(): Promise<TraktIds[]> {
  const rows = await api<ShowRow[]>(`/sync/watchlist/shows`)
  return rows.map((r) => r.show.ids)
}

// ---- change detection ------------------------------------------------------

/**
 * `/sync/last_activities` is a tiny document of "when did each kind of thing
 * last change" timestamps. Polling it is far cheaper than re-downloading the
 * whole watched history, so we use it to decide whether a resync is needed.
 * Note Trakt tracks watches for movies and *episodes* (not shows), while
 * watchlisting is tracked per movie/show/season/episode.
 */
interface ActivityGroup {
  watched_at?: string
  watchlisted_at?: string
}

export interface LastActivities {
  all?: string
  movies?: ActivityGroup
  shows?: ActivityGroup
  seasons?: ActivityGroup
  episodes?: ActivityGroup
}

export async function getLastActivities(): Promise<LastActivities> {
  return api<LastActivities>(`/sync/last_activities`)
}

/**
 * Collapse the activity timestamps we actually care about into one comparable
 * string. Deliberately ignores unrelated activity (ratings, comments, hides)
 * so those don't trigger a pointless full resync.
 */
export function exclusionFingerprint(a: LastActivities): string {
  return [
    a.movies?.watched_at,
    a.episodes?.watched_at,
    a.movies?.watchlisted_at,
    a.shows?.watchlisted_at,
    a.seasons?.watchlisted_at,
    a.episodes?.watchlisted_at,
  ]
    .map((t) => t ?? '')
    .join('|')
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
    // Movies need no call at all: Trakt resolves the external ids on its side.
    return { movies: [{ ids: item.media.ids, ...stampFor(mode) }] }
  }

  const id = pathId(item.media.ids)

  // Plex cards arrive without `status` because they were never looked up, so
  // the whole-series-vs-aired-seasons decision needs one call here. Paying it
  // per *mark* rather than per card shown is the whole point: you answer far
  // fewer titles than you see, and a wrong guess would claim episodes the user
  // never watched.
  let status = item.media.status
  if (status === undefined && id) {
    try {
      status = (await api<TraktMedia>(`/shows/${id}?extended=full`)).status
    } catch (e) {
      console.error('Could not read show status; marking aired seasons only', e)
    }
  }

  const ended = status ? ENDED.has(status) : false
  if (ended) {
    return { shows: [{ ids: item.media.ids, ...stampFor(mode) }] }
  }

  // Ongoing (or unknown): send only aired episodes. Erring this way is
  // deliberate — it under-claims rather than marking unaired/unseen episodes.
  if (!id) return { shows: [{ ids: item.media.ids, ...stampFor(mode) }] }
  const seasons = await getAiredSeasons(id)
  return { shows: [{ ids: item.media.ids, ...stampFor(mode), seasons }] }
}

type SeasonSummary = {
  number: number
  episodes: { number: number; first_aired: string | null }[]
}

/** `showId` may be a Trakt id, slug, or IMDb id — Trakt accepts all three. */
async function getAiredSeasons(showId: string): Promise<SeasonPayload[]> {
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

/**
 * `keepalive` lets a request outlive the page, which is what makes the
 * flush-on-unload path actually reach Trakt instead of being cancelled. It caps
 * the body at 64KB, so callers only set it on the unload path where losing the
 * batch is the alternative.
 */
export interface WriteOpts {
  keepalive?: boolean
}

export async function addToHistory(payload: HistoryPayload, opts: WriteOpts = {}): Promise<SyncResponse> {
  return api<SyncResponse>(`/sync/history`, {
    method: 'POST',
    body: JSON.stringify(payload),
    keepalive: opts.keepalive,
  })
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

export async function addToWatchlist(payload: HistoryPayload, opts: WriteOpts = {}): Promise<SyncResponse> {
  return api<SyncResponse>(`/sync/watchlist`, {
    method: 'POST',
    body: JSON.stringify(payload),
    keepalive: opts.keepalive,
  })
}

export async function removeFromWatchlist(item: FeedItem): Promise<void> {
  await api(`/sync/watchlist/remove`, { method: 'POST', body: JSON.stringify(buildWatchlistPayload(item)) })
}
