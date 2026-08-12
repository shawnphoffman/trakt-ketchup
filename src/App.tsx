import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from './components/Card'
import { beginLogin, clearTokens, completeLoginIfRedirected, loadTokens } from './lib/auth'
import {
  getMeta,
  markUnwatchedLocal,
  markUnwatchlistLocal,
  markWatchedLocal,
  markWatchlistLocal,
  recordSkip,
  removeSkip,
  replaceWatchedCache,
  replaceWatchlistCache,
  setMeta,
  type MediaType,
} from './lib/db'
import { Feed, type CardFeed } from './lib/feed'
import {
  beginPlexLogin,
  clearPlexToken,
  completePlexLoginIfRedirected,
  loadPlexToken,
} from './lib/plexAuth'
import { PlexFeed, type PlexFeedStatus } from './lib/plexFeed'
import { WatchedQueue } from './lib/queue'
import {
  loadPlexSettings,
  loadSettings,
  savePlexSettings,
  saveSettings,
  type FeedSource,
  type PlexSettings,
  type Settings,
} from './lib/settings'
import {
  exclusionFingerprint,
  getLastActivities,
  getWatchedMovieIds,
  getWatchedShowIds,
  getWatchlistMovieIds,
  getWatchlistShowIds,
  removeFromHistory,
  removeFromWatchlist,
  type FeedItem,
  type WatchedAt,
} from './lib/trakt'
import { gradientFor } from './lib/visual'

type Phase = 'loading' | 'need-config' | 'connect' | 'connect-plex' | 'ready' | 'error'

/**
 * Which deck this page is. `/plex` walks the user's own unwatched Plex library
 * instead of Trakt's popularity charts; everything else about the page (the
 * card, the buttons, the write queue, go-back) is identical, so the route is
 * just a switch on where cards come from.
 *
 * Read once at module load: the two pages are separate document loads, so there
 * is nothing to keep reactive.
 */
type Route = 'trakt' | 'plex'
const ROUTE: Route = location.pathname.replace(/\/+$/, '') === '/plex' ? 'plex' : 'trakt'

/** A reversible action, kept so go-back can restore the title and undo it. */
type PastAction =
  | { kind: 'skip'; item: FeedItem }
  | { kind: 'watched'; item: FeedItem; mode: WatchedAt }
  | { kind: 'watchlist'; item: FeedItem }

/** Fallback interval, used only when the cheap change-check is unavailable. */
const WATCHED_SYNC_TTL = 1000 * 60 * 60 * 6

type ResyncState = 'idle' | 'running' | 'done' | 'failed'

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string>('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [plexSettings, setPlexSettings] = useState<PlexSettings>(loadPlexSettings)
  const [plexStatus, setPlexStatus] = useState<PlexFeedStatus | null>(null)
  const [current, setCurrent] = useState<FeedItem | null>(null)
  const [pending, setPending] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [resyncState, setResyncState] = useState<ResyncState>('idle')

  const feedRef = useRef<CardFeed | null>(null)
  const queueRef = useRef<WatchedQueue | null>(null)
  const historyRef = useRef<PastAction[]>([])
  const [canGoBack, setCanGoBack] = useState(false)

  const advance = useCallback(async () => {
    const feed = feedRef.current
    if (!feed) return
    setCurrent(await feed.next())
  }, [])

  /** Build and warm the deck's source for the current route. */
  const buildFeed = useCallback(async (): Promise<CardFeed> => {
    if (ROUTE === 'plex') {
      const token = loadPlexToken()
      if (!token) throw new Error('Not connected to Plex.')
      const feed = new PlexFeed(settings.filter, plexSettings.sectionKeys, token)
      await feed.init()
      setPlexStatus(feed.status())
      return feed
    }
    const feed = new Feed(settings.filter, settings.source)
    await feed.init()
    return feed
  }, [settings.filter, settings.source, plexSettings.sectionKeys])

  // Bootstrap: complete OAuth redirect, then sync + build the feed.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!import.meta.env.VITE_TRAKT_CLIENT_ID) {
        setPhase('need-config')
        return
      }
      try {
        // Trakt is required on both pages: it's where every mark is written.
        await completeLoginIfRedirected()
        if (!loadTokens()) {
          setPhase('connect')
          return
        }
        if (ROUTE === 'plex') {
          await completePlexLoginIfRedirected()
          if (!loadPlexToken()) {
            setPhase('connect-plex')
            return
          }
        }
        await syncExclusionCaches()
        const feed = await buildFeed()
        if (cancelled) return
        feedRef.current = feed
        queueRef.current = new WatchedQueue(setPending)
        setCurrent(await feed.next())
        setPhase('ready')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Rebuild the feed when the media filter, source, or Plex libraries change.
  useEffect(() => {
    if (phase !== 'ready') return
    let cancelled = false
    ;(async () => {
      const feed = await buildFeed()
      if (cancelled) return
      feedRef.current = feed
      historyRef.current = [] // the old feed's items are gone; can't go back across a rebuild
      setCanGoBack(false)
      setCurrent(await feed.next())
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.filter, settings.source, plexSettings.sectionKeys])

  const onWatched = useCallback(async () => {
    const item = current
    if (!item || !feedRef.current || !queueRef.current) return
    feedRef.current.exclude(item.type, item.media.ids.trakt)
    await markWatchedLocal(item.type, item.media.ids.trakt)
    await queueRef.current.enqueue(item, 'history', settings.watchMode)
    historyRef.current.push({ kind: 'watched', item, mode: settings.watchMode })
    setCanGoBack(true)
    await advance()
  }, [current, settings.watchMode, advance])

  const onWatchlist = useCallback(async () => {
    const item = current
    if (!item || !feedRef.current || !queueRef.current) return
    feedRef.current.exclude(item.type, item.media.ids.trakt)
    await markWatchlistLocal(item.type, item.media.ids.trakt)
    await queueRef.current.enqueue(item, 'watchlist', settings.watchMode)
    historyRef.current.push({ kind: 'watchlist', item })
    setCanGoBack(true)
    await advance()
  }, [current, settings.watchMode, advance])

  const onSkip = useCallback(async () => {
    const item = current
    if (!item || !feedRef.current) return
    feedRef.current.exclude(item.type, item.media.ids.trakt)
    await recordSkip(item.type, item.media.ids.trakt, Date.now())
    historyRef.current.push({ kind: 'skip', item })
    setCanGoBack(true)
    await advance()
  }, [current, advance])

  // Restore the title you just acted on and reverse its side effects.
  const goBack = useCallback(async () => {
    const feed = feedRef.current
    if (!feed) return
    const last = historyRef.current.pop()
    if (!last) return
    setCanGoBack(historyRef.current.length > 0)

    // Put the title currently on screen back at the front so it isn't lost,
    // un-suppress the restored one, and show it immediately.
    if (current) feed.pushFront(current)
    feed.unexclude(last.item.type, last.item.media.ids.trakt)
    setCurrent(last.item)

    if (last.kind === 'skip') {
      await removeSkip(last.item.type, last.item.media.ids.trakt)
      return
    }

    // watched / watchlist: pull it back from the queue if it hasn't flushed yet,
    // otherwise undo it on Trakt. Either way, clear the optimistic local cache.
    const queue = queueRef.current
    const stillPending = queue?.unqueue(last.item) ?? false
    if (last.kind === 'watched') {
      await markUnwatchedLocal(last.item.type, last.item.media.ids.trakt)
      if (!stillPending) {
        try {
          await removeFromHistory(last.item, last.mode)
        } catch (e) {
          console.error('Go-back: failed to remove from Trakt history', e)
        }
      }
    } else {
      await markUnwatchlistLocal(last.item.type, last.item.media.ids.trakt)
      if (!stillPending) {
        try {
          await removeFromWatchlist(last.item)
        } catch (e) {
          console.error('Go-back: failed to remove from Trakt watchlist', e)
        }
      }
    }
  }, [current])

  // Keyboard nav: J/← skip, K/→/Space watched.
  useEffect(() => {
    if (phase !== 'ready') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSettings(false)
        return
      }
      if (showSettings) return
      if (e.key === 'j' || e.key === 'ArrowLeft') {
        e.preventDefault()
        void onSkip()
      } else if (e.key === 'k' || e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        void onWatched()
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault()
        void onWatchlist()
      } else if (e.key === 'Backspace' || e.key === 'u' || e.key === 'U') {
        e.preventDefault()
        void goBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, showSettings, onSkip, onWatched, onWatchlist, goBack])

  /** Force a full re-download of the exclusion caches, then rebuild the feed so
   *  anything newly known-watched drops out of the buffer immediately. */
  const resync = useCallback(async () => {
    setResyncState('running')
    try {
      await queueRef.current?.flush() // land pending marks first, or we'd pull stale state
      await syncExclusionCaches({ force: true })
      const feed = await buildFeed()
      feedRef.current = feed
      historyRef.current = []
      setCanGoBack(false)
      setCurrent(await feed.next())
      setResyncState('done')
    } catch {
      setResyncState('failed')
    }
  }, [buildFeed])

  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }

  const updatePlexSettings = (patch: Partial<PlexSettings>) => {
    setPlexSettings((prev) => {
      const next = { ...prev, ...patch }
      savePlexSettings(next)
      return next
    })
  }

  if (phase === 'loading') {
    return <Centered>{ROUTE === 'plex' ? 'Scanning your Plex libraries…' : 'Loading…'}</Centered>
  }
  if (phase === 'need-config') return <NeedConfig />
  if (phase === 'error') return <Centered>Something broke: {error}</Centered>
  if (phase === 'connect') return <Connect />
  if (phase === 'connect-plex') return <ConnectPlex />

  return (
    <div className="app">
      <Backdrop item={current} />
      <div className="brand">
        <span className="brand-title">
          <Logo className="brand-logo" />
          Trakt <span className="accent">Ketchup</span>
          {ROUTE === 'plex' && <span className="brand-sub">Plex library</span>}
        </span>
        <div className="brand-right">
          <a className="brand-link" href={ROUTE === 'plex' ? '/' : '/plex'}>
            {ROUTE === 'plex' ? 'Popular titles' : 'My Plex library'}
          </a>
          {pending > 0 && (
            <span
              className="queue-chip"
              title={`${pending} mark${pending === 1 ? '' : 's'} waiting to sync`}
            >
              <span className="queue-dot" />
              {pending} queued
            </span>
          )}
          <button
            className="icon-btn"
            onClick={() => void goBack()}
            disabled={!canGoBack}
            aria-label="Go back to the previous title"
            title="Go back (Backspace)"
          >
            <BackIcon />
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings">
            <GearIcon />
          </button>
        </div>
      </div>

      <div
        className={`drawer-scrim ${showSettings ? 'open' : ''}`}
        onClick={() => setShowSettings(false)}
      />
      <aside className={`drawer ${showSettings ? 'open' : ''}`} aria-hidden={!showSettings}>
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="Close settings">
            ✕
          </button>
        </div>
        <SettingsPanel
          settings={settings}
          onChange={updateSettings}
          plexSettings={plexSettings}
          onPlexChange={updatePlexSettings}
          plexStatus={plexStatus}
          resyncState={resyncState}
          onResync={() => void resync()}
          onDisconnect={() => {
            clearTokens()
            clearPlexToken()
            location.reload()
          }}
          onDisconnectPlex={() => {
            clearPlexToken()
            location.reload()
          }}
        />
      </aside>

      <main className="stage">
        {current ? (
          <>
            <Card item={current} />
            <div className="action-group">
              <div className="actions">
                <button className="btn btn-skip big" onClick={() => void onSkip()}>
                  Not Watched
                  <kbd>J</kbd>
                </button>
                <button className="btn btn-watched big" onClick={() => void onWatched()}>
                  Watched It
                  <kbd>K</kbd>
                </button>
              </div>
              <button className="btn btn-watchlist watchlist-btn" onClick={() => void onWatchlist()}>
                Watchlist
                <kbd>W</kbd>
              </button>
            </div>
          </>
        ) : ROUTE === 'plex' ? (
          <Centered>
            That's every unwatched title in your Plex libraries. 🎉
            {plexStatus && plexStatus.unmatched > 0 && (
              <p className="setting-hint">
                {plexStatus.unmatched} Plex item{plexStatus.unmatched === 1 ? '' : 's'} couldn't be
                matched to a Trakt title and {plexStatus.unmatched === 1 ? 'was' : 'were'} skipped.
              </p>
            )}
          </Centered>
        ) : (
          <Centered>You're all caught up. Nothing left to ask about. 🎉</Centered>
        )}
      </main>

      <Footer />
    </div>
  )
}

/** Trakt API attribution (required by their terms) plus a one-line privacy
 *  note. Tokens and skip-memory never leave the browser; the only server-side
 *  piece is the stateless OAuth token proxy. */
function Footer() {
  return (
    <footer className="app-footer">
      <span>
        This product uses the{' '}
        <a href="https://trakt.tv" target="_blank" rel="noreferrer noopener">
          Trakt
        </a>{' '}
        API but is not endorsed or certified by Trakt.
      </span>
      <span className="footer-sep" aria-hidden="true">
        ·
      </span>
      <span>Your Trakt login stays in your browser. Nothing is stored on our servers.</span>
    </footer>
  )
}

/** Landing screen shown before the user has connected. States the purpose, how
 *  it works, and the privacy posture, then hands off to the Trakt OAuth flow. */
function Connect() {
  return (
    <>
      <Backdrop item={null} />
      <div className="connect">
        <div className="connect-card">
          <span className="connect-brand">
            <Logo className="connect-logo" />
            Trakt <span className="accent">Ketchup</span>
          </span>
          <h1 className="connect-title">Catch Trakt up on a lifetime of watching</h1>
          <p className="connect-lede">
            Trakt's recommendations are only as good as the history behind them. Ketchup walks you
            through the most-watched movies and shows of all time, one at a time, so you can backfill
            what you've already seen in a few minutes.
          </p>
          <ol className="connect-steps">
            <li>
              <strong>One title at a time.</strong> Tap Watched or Skip, or use your keyboard.
            </li>
            <li>
              <strong>No repeats.</strong> Titles already in your history are hidden, and skips stay
              gone for months.
            </li>
            <li>
              <strong>Synced as you go.</strong> Marks batch up and post to your Trakt history in the
              background.
            </li>
          </ol>
          <button className="btn btn-primary connect-btn" onClick={beginLogin}>
            Connect Trakt
          </button>
          <p className="connect-fine">
            You'll sign in on Trakt. Your login stays in your browser, and nothing is stored on our
            servers.
          </p>
        </div>
      </div>
    </>
  )
}

/** Landing screen for /plex, shown once Trakt is connected but Plex isn't. */
function ConnectPlex() {
  return (
    <>
      <Backdrop item={null} />
      <div className="connect">
        <div className="connect-card">
          <span className="connect-brand">
            <Logo className="connect-logo" />
            Trakt <span className="accent">Ketchup</span>
          </span>
          <h1 className="connect-title">Backfill from your own Plex library</h1>
          <p className="connect-lede">
            Ketchup walks the titles you own but that Plex has never seen you play. Plenty of them
            you watched years ago somewhere else, so this is the highest-yield backfill there is:
            you already cared enough to keep a copy.
          </p>
          <ol className="connect-steps">
            <li>
              <strong>Only the unplayed.</strong> Anything Plex already counts as watched is left
              out entirely.
            </li>
            <li>
              <strong>Matched to Trakt.</strong> Titles are resolved by their IMDb/TMDB/TVDB ids, so
              marks land on the right entry.
            </li>
            <li>
              <strong>No repeats.</strong> Whatever is already in your Trakt history or watchlist
              never comes up.
            </li>
          </ol>
          <button
            className="btn btn-primary connect-btn"
            onClick={() => void beginPlexLogin(`${location.origin}/plex`)}
          >
            Connect Plex
          </button>
          <p className="connect-fine">
            You'll sign in on plex.tv. Your browser talks to your Plex server directly; nothing
            about your library reaches our servers.
          </p>
        </div>
      </div>
    </>
  )
}

/**
 * Pull the user's watched history and watchlist into the IndexedDB exclusion
 * caches so the feed never resurfaces a title they've seen or already saved.
 *
 * Gated on `/sync/last_activities` rather than a blind interval: that call is
 * tiny, so we can check on every load and only pay for the full download when
 * Trakt's own timestamps say something actually changed. Marks made on another
 * device therefore show up on the next load instead of up to 6h later.
 */
async function syncExclusionCaches({ force = false } = {}) {
  // Recorded only after a successful download, and deliberately sampled BEFORE
  // it: anything that changes on Trakt mid-download is then still newer than
  // what we stored, so the next load picks it up rather than skipping it.
  let fingerprint: string | undefined
  try {
    fingerprint = exclusionFingerprint(await getLastActivities())
  } catch {
    fingerprint = undefined
  }

  if (!force) {
    if (fingerprint !== undefined) {
      if (fingerprint === (await getMeta<string>('exclusionsFingerprint'))) return
    } else {
      // If the check itself fails, fall back to the interval so a transient
      // error can't strand the caches indefinitely.
      const last = (await getMeta<number>('exclusionsSyncedAt')) ?? 0
      if (Date.now() - last < WATCHED_SYNC_TTL) return
    }
  }

  const [movieIds, showIds, wlMovieIds, wlShowIds] = await Promise.all([
    getWatchedMovieIds(),
    getWatchedShowIds(),
    getWatchlistMovieIds(),
    getWatchlistShowIds(),
  ])
  const entries = (ids: number[], type: MediaType) => ids.map((id) => ({ type, traktId: id }))
  await replaceWatchedCache([...entries(movieIds, 'movie'), ...entries(showIds, 'show')])
  await replaceWatchlistCache([...entries(wlMovieIds, 'movie'), ...entries(wlShowIds, 'show')])
  await setMeta('exclusionsSyncedAt', Date.now())
  if (fingerprint !== undefined) await setMeta('exclusionsFingerprint', fingerprint)
}

/** Full-viewport ambient background: the current title's blurred backdrop over
 *  its gradient. Re-keyed per image so each new card crossfades in. */
function Backdrop({ item }: { item: FeedItem | null }) {
  return (
    <div className="backdrop" style={{ background: gradientFor(item?.media.title ?? '') }}>
      {item?.backdrop && (
        <div
          key={item.backdrop}
          className="backdrop-img"
          style={{ backgroundImage: `url(${item.backdrop})` }}
        />
      )}
      <div className="backdrop-scrim" />
    </div>
  )
}

/** The Ketchup mark: a squeeze-bottle silhouette with a check knocked out of
 *  it, filled with the warm Trakt-family gradient. */
function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 60.8 61.4"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ketchupGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e23028" />
          <stop offset="0.55" stopColor="#c01818" />
          <stop offset="1" stopColor="#8c0d0d" />
        </linearGradient>
      </defs>
      <path
        fill="url(#ketchupGrad)"
        d="M43.742188,9.374001c-2.130859-.709961-3.954102-1.74707-5.717773-2.749512-2.755859-1.567871-5.381836-3.061035-8.844238-3.061035-.578613,0-1.179688.041504-1.80957.131836l-.008789.000977c-7.790527.973633-15.725586,4.674316-20.708496,9.657227-4.263184,3.65625-3.913574,8.421875-3.542969,13.466797.211426,2.880371.429688,5.858398-.32959,8.517578-1.866699,7.466797,3.60498,12.318359,9.796387,16.446289l.523438.297852c6.717285,3.841797,11.570801,6.618164,20.199219,6.618164,6.125977,0,9.948242-4.441406,13.320312-8.360352,1.47168-1.709961,2.862305-3.326172,4.367188-4.530273,5.678711-3.552734,5.628906-9.21875,5.581055-14.697266-.017578-2.006348-.035156-4.080566.236328-5.98291,1.654297-7.45166-2.253906-12.152344-13.0625-15.755371ZM55.103516,24.711891c-.012695.055176-.022461.111816-.03125.168457-.289062,2.026367-.271484,4.158203-.253906,6.220215.054688,6.351562-.234375,10.393555-4.710938,13.191406-.075195.046875-.146484.097656-.214844.152344-1.62793,1.301758-3.06543,2.972656-4.587891,4.742188-3.441406,3.999023-6.681641,7.763672-12.004883,7.763672-8.162598,0-12.604004-2.540039-19.327637-6.385742l-.465332-.265625c-6.530273-4.363281-10.539062-8.493164-9.023926-14.552734.825684-2.886719.595215-6.021973.372559-9.053223-.407715-5.556152-.415527-9.135254,2.908203-11.984375.044922-.038086.085449-.075684.124512-.115234,4.723633-4.723145,12.268066-8.232422,19.69043-9.160156,3.83252-.543945,6.444824.929199,9.581543,2.712402,1.75.995605,3.733398,2.124023,6.029297,2.88916,12.235352,4.078125,12.957031,8.983398,11.914062,13.677246Z"
      />
      <path
        fill="url(#ketchupGrad)"
        d="M53.318359,31.140114c-.017578-2.144531-.036133-4.333984.269531-6.470215.012695-.094238.030273-.187988.050781-.282227,1.058594-4.765137-.399414-8.422363-10.923828-11.930176-2.435547-.811523-4.486328-1.978516-6.296875-3.008301-2.487305-1.414551-4.636719-2.636719-7.224121-2.636719-.445312,0-.908691.035156-1.416504.107422-7.120117.890137-14.329102,4.235352-18.826172,8.731445-.066895.067383-.138672.134277-.213379.197754-2.847656,2.440918-2.769531,5.513184-2.38623,10.733887.232422,3.162109.472656,6.432617-.419922,9.550781-1.300293,5.203125,2.235352,8.792969,8.364258,12.890625l.417969.236328c6.518066,3.727539,10.822266,6.189453,18.585938,6.189453,4.634766,0,7.657227-3.511719,10.856445-7.229492,1.581055-1.836914,3.0625-3.558594,4.800781-4.949219.115234-.09082.233398-.174805.356445-.251953,3.896484-2.435547,4.056641-5.923828,4.004883-11.879395ZM42.865234,24.095192l-14,17.999512c-.595703.765625-1.501953,1.225586-2.47168,1.253906-.03125.000977-.0625.000977-.09375.000977-.935547,0-1.827637-.40332-2.445801-1.109375l-7-8c-1.182129-1.351562-1.044922-3.404297.305664-4.586426,1.352051-1.182129,3.404297-1.044922,4.585938.305664l4.406738,5.036621,11.582031-14.891113c1.102539-1.417969,3.145508-1.672363,4.560547-.570312,1.416992,1.102051,1.671875,3.144043.570312,4.560547Z"
      />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>
}

function NeedConfig() {
  return (
    <div className="centered config">
      <h2>Almost there</h2>
      <p>
        Set <code>VITE_TRAKT_CLIENT_ID</code>, <code>TRAKT_CLIENT_SECRET</code>, and{' '}
        <code>VITE_TRAKT_REDIRECT_URI</code> in <code>.env</code>, then restart.
      </p>
      <p>
        Register an app at <code>trakt.tv/oauth/applications</code> and add this origin to its
        JavaScript (CORS) origins.
      </p>
    </div>
  )
}

function SettingsPanel({
  settings,
  onChange,
  plexSettings,
  onPlexChange,
  plexStatus,
  resyncState,
  onResync,
  onDisconnect,
  onDisconnectPlex,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  plexSettings: PlexSettings
  onPlexChange: (patch: Partial<PlexSettings>) => void
  plexStatus: PlexFeedStatus | null
  resyncState: ResyncState
  onResync: () => void
  onDisconnect: () => void
  onDisconnectPlex: () => void
}) {
  return (
    <div className="settings-panel">
      {ROUTE === 'plex' ? (
        <PlexLibraryPicker settings={plexSettings} onChange={onPlexChange} status={plexStatus} />
      ) : (
        <div className="setting">
          <span>Source</span>
          <select
            className="select"
            value={settings.source}
            onChange={(e) => onChange({ source: e.target.value as FeedSource })}
          >
            <option value="mix">Surprise mix</option>
            <option value="watched">Most watched (all time)</option>
            <option value="popular">Popular</option>
            <option value="trending">Trending now</option>
            <option value="recent">Most watched this month</option>
            <option value="classics">Classics (pre-2000)</option>
          </select>
        </div>
      )}
      <div className="setting">
        <span>Show</span>
        <div className="segmented">
          {(['both', 'movies', 'shows'] as const).map((f) => (
            <button key={f} className={settings.filter === f ? 'on' : ''} onClick={() => onChange({ filter: f })}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <span>Watched date</span>
        <div className="segmented">
          {(['unknown', 'released'] as const).map((m) => (
            <button key={m} className={settings.watchMode === m ? 'on' : ''} onClick={() => onChange({ watchMode: m })}>
              {m === 'unknown' ? 'Unknown date' : 'Release date'}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <button className="btn btn-ghost" onClick={onResync} disabled={resyncState === 'running'}>
          {resyncState === 'running' ? 'Re-syncing…' : 'Re-sync from Trakt'}
        </button>
        <span className="setting-hint">
          {resyncState === 'done'
            ? 'Up to date with Trakt.'
            : resyncState === 'failed'
              ? "Couldn't reach Trakt. Try again in a moment."
              : 'Re-download your watched history and watchlist so already-seen titles stop appearing.'}
        </span>
      </div>
      {ROUTE === 'plex' && (
        <button className="btn btn-ghost danger" onClick={onDisconnectPlex}>
          Disconnect Plex
        </button>
      )}
      <button className="btn btn-ghost danger" onClick={onDisconnect}>
        Disconnect Trakt
      </button>
    </div>
  )
}

/**
 * Which Plex libraries the deck reads. An empty selection means every movie and
 * show library, so a first-time user gets a working feed without touching this.
 */
function PlexLibraryPicker({
  settings,
  onChange,
  status,
}: {
  settings: PlexSettings
  onChange: (patch: Partial<PlexSettings>) => void
  status: PlexFeedStatus | null
}) {
  const sections = status?.sections ?? []
  const selected = (key: string) =>
    settings.sectionKeys.length === 0 || settings.sectionKeys.includes(key)

  const toggle = (key: string) => {
    // Materialize "all" into an explicit list on first toggle, so unticking one
    // library doesn't read as unticking every library.
    const current = settings.sectionKeys.length === 0 ? sections.map((s) => s.key) : settings.sectionKeys
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    onChange({ sectionKeys: next })
  }

  return (
    <div className="setting">
      <span>Libraries</span>
      {sections.length === 0 ? (
        <span className="setting-hint">No Plex libraries loaded yet.</span>
      ) : (
        <div className="checklist">
          {sections.map((section) => (
            <label key={section.key} className="checklist-item">
              <input type="checkbox" checked={selected(section.key)} onChange={() => toggle(section.key)} />
              <span>{section.title}</span>
              <span className="checklist-type">{section.type === 'movie' ? 'Movies' : 'TV'}</span>
            </label>
          ))}
        </div>
      )}
      {status && (
        <span className="setting-hint">
          {status.server ? `${status.server} · ` : ''}
          {status.candidates} unwatched title{status.candidates === 1 ? '' : 's'} left to review
          {status.unmatched > 0 ? ` · ${status.unmatched} unmatched` : ''}
        </span>
      )}
    </div>
  )
}
