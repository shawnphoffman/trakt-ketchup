import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from './components/Card'
import { beginLogin, clearTokens, completeLoginIfRedirected, loadTokens } from './lib/auth'
import { getMeta, recordSkip, replaceWatchedCache, setMeta, type MediaType } from './lib/db'
import { Feed } from './lib/feed'
import { WatchedQueue } from './lib/queue'
import { loadSettings, saveSettings, type Settings } from './lib/settings'
import { getWatchedMovieIds, getWatchedShowIds, type FeedItem } from './lib/trakt'
import { gradientFor } from './lib/visual'

type Phase = 'loading' | 'need-config' | 'connect' | 'ready' | 'error'

const WATCHED_SYNC_TTL = 1000 * 60 * 60 * 6 // re-sync the watched cache every 6h

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string>('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [current, setCurrent] = useState<FeedItem | null>(null)
  const [pending, setPending] = useState(0)
  const [showSettings, setShowSettings] = useState(false)

  const feedRef = useRef<Feed | null>(null)
  const queueRef = useRef<WatchedQueue | null>(null)

  const advance = useCallback(async () => {
    const feed = feedRef.current
    if (!feed) return
    setCurrent(await feed.next())
  }, [])

  // Bootstrap: complete OAuth redirect, then sync + build the feed.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!import.meta.env.VITE_TRAKT_CLIENT_ID) {
        setPhase('need-config')
        return
      }
      try {
        await completeLoginIfRedirected()
        if (!loadTokens()) {
          setPhase('connect')
          return
        }
        await syncWatchedCache()
        const feed = new Feed(settings.filter)
        await feed.init()
        if (cancelled) return
        feedRef.current = feed
        queueRef.current = new WatchedQueue()
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

  // Rebuild the feed when the media filter changes.
  useEffect(() => {
    if (phase !== 'ready') return
    let cancelled = false
    ;(async () => {
      const feed = new Feed(settings.filter)
      await feed.init()
      if (cancelled) return
      feedRef.current = feed
      setCurrent(await feed.next())
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.filter])

  const onWatched = useCallback(async () => {
    const item = current
    if (!item || !feedRef.current || !queueRef.current) return
    feedRef.current.exclude(item.type, item.media.ids.trakt)
    await queueRef.current.enqueue(item, settings.watchMode)
    setPending(queueRef.current.pendingCount)
    await advance()
  }, [current, settings.watchMode, advance])

  const onSkip = useCallback(async () => {
    const item = current
    if (!item || !feedRef.current) return
    feedRef.current.exclude(item.type, item.media.ids.trakt)
    await recordSkip(item.type, item.media.ids.trakt, Date.now())
    await advance()
  }, [current, advance])

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, showSettings, onSkip, onWatched])

  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }

  if (phase === 'loading') return <Centered>Loading…</Centered>
  if (phase === 'need-config') return <NeedConfig />
  if (phase === 'error') return <Centered>Something broke: {error}</Centered>
  if (phase === 'connect')
    return (
      <Centered>
        <button className="btn btn-primary big" onClick={beginLogin}>
          Connect Trakt
        </button>
      </Centered>
    )

  return (
    <div className="app">
      <Backdrop item={current} />
      <div className="brand">
        <span className="brand-title">
          Trakt <span className="accent">Ketchup</span>
        </span>
        <div className="brand-right">
          {pending > 0 && (
            <span
              className="queue-chip"
              title={`${pending} mark${pending === 1 ? '' : 's'} waiting to sync`}
            >
              <span className="queue-dot" />
              {pending} queued
            </span>
          )}
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
          onDisconnect={() => {
            clearTokens()
            location.reload()
          }}
        />
      </aside>

      <main className="stage">
        {current ? (
          <>
            <Card item={current} />
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
          </>
        ) : (
          <Centered>You're all caught up. Nothing left to ask about. 🎉</Centered>
        )}
      </main>
    </div>
  )
}

/** Pull the user's full watched history into the IndexedDB exclusion cache. */
async function syncWatchedCache() {
  const last = (await getMeta<number>('watchedSyncedAt')) ?? 0
  if (Date.now() - last < WATCHED_SYNC_TTL) return

  const [movieIds, showIds] = await Promise.all([getWatchedMovieIds(), getWatchedShowIds()])
  const entries: Array<{ type: MediaType; traktId: number }> = [
    ...movieIds.map((id) => ({ type: 'movie' as const, traktId: id })),
    ...showIds.map((id) => ({ type: 'show' as const, traktId: id })),
  ]
  await replaceWatchedCache(entries)
  await setMeta('watchedSyncedAt', Date.now())
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
  onDisconnect,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onDisconnect: () => void
}) {
  return (
    <div className="settings-panel">
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
      <button className="btn btn-ghost danger" onClick={onDisconnect}>
        Disconnect Trakt
      </button>
    </div>
  )
}
