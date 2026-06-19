# Trakt Catchup

A dead-simple, fast web app for backfilling your Trakt watch history. It shows
you one popular movie or show at a time and you tap **Watched** or **Skip**. The
goal: get Trakt caught up on everything you've seen in your life so its
recommendations are actually accurate.

## How it works

- **One card at a time**, big buttons, keyboard nav (`J`/`←` skip, `K`/`→`/`Space` watched).
- **High-yield feed:** pulls Trakt's "most watched of all time" lists (movies +
  shows), because those are the titles you're most likely to have already seen.
- **Never repeats:** anything already in your Trakt history is hidden, and items
  you skip are suppressed for ~180 days (the skip-memory) so you aren't asked
  about them again.
- **Batched writes:** marks are queued and flushed to `/sync/history` together,
  rather than one request per tap, to stay friendly with Trakt's rate limits.
- **Prefetch-ahead:** the next cards are fetched in the background so the UI
  never waits.

## Architecture

```
Browser (Vite + React SPA)  ──direct──▶  Trakt API   (feed, watched history, sync/history)
        │
        └──/api/oauth/token──▶  Vercel serverless fn  ──▶  Trakt OAuth  (holds CLIENT SECRET)
```

Only the OAuth token exchange/refresh runs server-side (so the client secret
never reaches the browser). Every other Trakt call goes directly from the
browser, which works because Trakt returns CORS headers for the JavaScript
origins you register on your app.

State lives in the browser:

- **IndexedDB** (`src/lib/db.ts`): the watched-history exclusion cache + skip-memory.
- **localStorage**: OAuth tokens and user settings.

## Setup

1. Register an app at <https://trakt.tv/oauth/applications>.
   - **Redirect URI:** `http://localhost:3000` for dev (and your Vercel URL for prod).
   - **JavaScript (CORS) origins:** add `http://localhost:3000` and your Vercel URL.
     (Required, or direct browser calls are blocked by CORS.)
2. Copy `.env.example` to `.env.local` and fill in the three values.
3. Install and run:

   ```sh
   npm install
   vercel dev       # serves the SPA AND the /api OAuth function on port 3000
   ```

   Run the `vercel dev` binary directly — do **not** wrap it in the `dev` npm
   script, or it recursively invokes itself. `vercel dev` calls `npm run dev`
   (plain Vite) for the frontend and layers the `/api` functions on top. Plain
   `npm run dev` serves the SPA only, so the OAuth token exchange won't work.

## Settings

- **Show:** movies / shows / both.
- **Watched date** (we NEVER mark something watched as "now"):
  - **Unknown date** (default): sends the epoch sentinel
    `watched_at: "1970-01-01T00:00:00.000Z"`, which Trakt treats as a watched
    entry with no known date.
  - **Release date:** sends `watched_at: "released"` so Trakt backfills the title's release date.

## Open / to verify

- **Unknown-date write format.** Trakt shipped "Mark Watched at Unknown Date"
  in Oct 2025, initially web-only with API support "to follow". Unknown-date
  entries surface in history with the year 1969/1970, i.e. the Unix epoch, so
  we send `watched_at: 1970-01-01T00:00:00.000Z` as the sentinel. This is a
  strong inference, not confirmed from the docs. **TODO:** make one
  authenticated test call, then read back `/sync/history` and confirm the entry
  shows as unknown-date (not a literal 1970 watch). If Trakt now exposes a
  dedicated value (e.g. `watched_at: "unknown"` or `null`), switch the
  `UNKNOWN_DATE` constant in `src/lib/trakt.ts` to it. Until confirmed, do NOT
  fall back to "now" — surface an error instead.

## Possible next steps

- Genre / decade filters on the feed (the engine already paginates per source;
  add `?genres=` / `?years=` to the calls in `src/lib/trakt.ts`).
- Poster art (Trakt IDs include `tmdb`; fetch images from TMDB).
- Blend more sources into the feed (trending, anticipated, box office).
- Cross-device sync of the skip-memory (move it from IndexedDB to a backend store).
- Undo for an accidental "Watched" before the batch flushes.
