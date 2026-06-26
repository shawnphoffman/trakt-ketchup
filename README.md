# Trakt Ketchup

A dead-simple, fast web app for backfilling your Trakt watch history. It shows
you one popular movie or show at a time and you tap **Watched** or **Skip**. The
goal: get Trakt caught up on everything you've seen in your life so its
recommendations are actually accurate.

## How it works

- **One card at a time**, big buttons, keyboard nav (`J`/`←` skip,
  `W` watchlist, `K`/`→`/`Space` watched, `Backspace` undo).
- **Watchlist too:** besides Watched/Skip you can add a title to your Trakt
  watchlist, for stuff you haven't seen but want to.
- **Variety in the feed:** pick a source (most-watched all-time, popular,
  trending, this month) or the default "Surprise mix" that blends several wells
  so you aren't shown the same all-time list every session.
- **Never repeats:** anything already in your Trakt history or watchlist is
  hidden, and items you skip are suppressed for ~180 days (the skip-memory) so
  you aren't asked about them again.
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

## Tests

`npm test` runs the Vitest suite (`npm run test:watch` for watch mode). Coverage
focuses on the write path — `buildHistoryPayload()` (movie / completed show /
ongoing-show season filtering) and the batch `mergePayloads()` — since that's the
code that writes to a user's permanent Trakt history.

## Settings

- **Source:** which well the feed pulls from. "Surprise mix" (default) blends
  most-watched all-time, popular, trending, and most-watched-this-month for
  variety; or pin a single source. Changing it rebuilds the feed.
- **Show:** movies / shows / both.
- **Watched date** (we NEVER mark something watched as "now"):
  - **Unknown date** (default): sends the epoch sentinel
    `watched_at: "1970-01-01T00:00:00.000Z"`, which Trakt treats as a watched
    entry with no known date.
  - **Release date:** sends `watched_at: "released"` so Trakt backfills the title's release date.

## Security

- **OAuth CSRF guard:** `beginLogin()` sends a random `state`, and
  `completeLoginIfRedirected()` requires it back before spending the code, so a
  forged `?code=` callback can't connect your session to another account.
- **Proxy origin lock:** `/api/oauth/token` rejects any request whose `Origin`
  isn't in the allowlist (the app's own redirect-URI origin, localhost, plus an
  optional `ALLOWED_ORIGINS` comma-separated env var). Keeps third parties from
  burning the Trakt app's rate limit through our credentials.
- **Proxy rate limit:** the same endpoint caps requests per IP (best-effort,
  per warm instance) and returns `429` past the limit, as a speed bump against
  abuse beyond the origin lock.
- **CSP + headers:** a strict Content-Security-Policy is injected into the built
  HTML (`vite.config.ts`); `X-Frame-Options`, `X-Content-Type-Options`, and
  `Referrer-Policy` come from `vercel.json`. Trakt tokens live in `localStorage`,
  so the CSP's `script-src 'self'` is the main line of defense against token
  theft via injected script.

## Verified behavior

- **Unknown-date write format (confirmed).** Sending
  `watched_at: 1970-01-01T00:00:00.000Z` registers in Trakt history under the
  "Unknown Date" section (not a literal 1970 watch) — verified by marking titles
  and reading them back in the Trakt UI. The hard rule still holds: never fall
  back to "now"; if the sentinel is ever rejected, surface an error.

## Possible next steps

- Genre / decade filters on the feed (`getFeedPage` already builds the URL per
  source; add `?genres=` / `?years=` there in `src/lib/trakt.ts`).
- Deeper/randomized pagination within a source for even more variety.
- Poster art (Trakt IDs include `tmdb`; fetch images from TMDB).
- Cross-device sync of the skip-memory (move it from IndexedDB to a backend store).
