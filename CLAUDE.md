# Trakt Ketchup — project context

A fast, dead-simple web app for backfilling your Trakt watch history: shows one
popular movie/show at a time, you tap **Watched** or **Skip**. Goal is to get
Trakt caught up on everything you've watched in your life so its recommendations
become accurate. See [README.md](README.md) for architecture and setup.

## Hard rules (do not violate)

- **Never mark anything watched as "now".** Marking always sends an explicit
  `watched_at`: either the unknown-date sentinel or `"released"`. If the sentinel
  is ever rejected by the API, surface an error — do NOT fall back to current time.
- Direct browser→Trakt calls for everything except OAuth token exchange/refresh,
  which must stay server-side (client secret never reaches the browser).

## Locked design decisions

- **Feed = high-yield backfill:** pull Trakt's "most watched of all time" lists
  (movies + shows), because those are the titles the user most likely already
  saw. Personalized recs are deliberately not used (weak until history is built).
- **Never repeat:** hard-exclude anything already in Trakt history; suppress
  skipped items for ~180 days (skip-memory).
- **Storage:** IndexedDB for the watched-exclusion cache + skip-memory
  (`src/lib/db.ts`); localStorage for OAuth tokens + settings.
- **Watched-date setting:** `unknown` (default) vs `released`. `unknown` sends the
  Unix-epoch sentinel `1970-01-01T00:00:00.000Z` (Trakt renders epoch as "unknown
  date"); `released` sends `watched_at: "released"`. See `stampFor()` in
  `src/lib/trakt.ts`.
- **TV granularity:** completed series (status ended/canceled) → mark whole show;
  ongoing series → mark only aired seasons/episodes. See `buildHistoryPayload()`.
- **Not-watched (Skip):** records nothing on Trakt; only advances + adds to
  skip-memory.
- **Writes are batched:** queue marks and flush together to `/sync/history`
  (`src/lib/queue.ts`), not one request per tap. Optimistic local update so the
  feed never resurfaces a just-marked item.
- **UX:** one big card, big Watched/Skip buttons, keyboard nav (`J`/`←` skip,
  `K`/`→`/`Space` watched), prefetch-ahead feed so the UI never waits.

## Stack

Vite + React + TypeScript SPA, deployed on Vercel. OAuth proxy is a Vercel
serverless function at `api/oauth/token.ts`. Local dev: run `vercel dev`
directly (NOT `npm run dev` — that's plain Vite and won't serve `/api`). The
`dev` npm script is intentionally just `vite` to avoid `vercel dev` recursion.

Env vars live in a single gitignored `.env` (NOT `.env.local`): `vercel dev`'s
function runtime reads `.env`, and Vite reads `.env` too, so one file serves
both the browser build and the `/api` proxy. Restart `vercel dev` after editing
it. Note: `vercel.json`'s SPA rewrite excludes vite-internal prefixes
(`@`/`src/`/`node_modules/`) so `vercel dev` doesn't serve HTML for dev modules.

## Current status (handoff)

- Scaffold complete; `npm run typecheck` and `npm run build` both pass.
- **Runs locally under `vercel dev`.** Trakt app registered, `.env` filled
  (`VITE_TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`, `VITE_TRAKT_REDIRECT_URI`),
  redirect URI + JS/CORS origins set to `http://localhost:3000`. App renders
  the Connect Trakt screen and the OAuth proxy reaches Trakt (verified the
  token endpoint returns a Trakt-origin response, not a misconfig error).
- **Full OAuth round-trip not yet confirmed end-to-end** (login → card feed).

## Immediate next steps

1. Click Connect Trakt, complete login, confirm a card loads.
2. **F3 verification:** mark one title with `unknown` mode, then read back
   `/sync/history` and confirm it shows as unknown-date — NOT a literal 1970
   watch. The epoch-0 sentinel is a strong inference, not doc-confirmed. If
   Trakt now exposes a dedicated value (`"unknown"` / `null`), update the
   `UNKNOWN_DATE` constant in `src/lib/trakt.ts`.

## Possible later work (not committed)

Genre/decade filters on the feed, TMDB poster art, blending more feed sources
(trending/anticipated/box office), cross-device skip-memory sync, undo before
flush.
