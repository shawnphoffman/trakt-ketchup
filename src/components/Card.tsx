import type { FeedItem } from '../lib/trakt'
import { gradientFor, initials } from '../lib/visual'

const ONGOING = new Set(['returning series', 'in production', 'planned'])

export function Card({ item }: { item: FeedItem }) {
  const { media, type, poster } = item
  // Plex cards carry no status: whether a series is finished is only looked up
  // if and when the user marks it. Showing nothing beats guessing "Full series"
  // and implying we'll mark every episode.
  const ongoing = media.status ? ONGOING.has(media.status) : null

  return (
    <article className="card glass">
      <div
        className="poster"
        style={poster ? { backgroundImage: `url(${poster})` } : { background: gradientFor(media.title) }}
      >
        {!poster && <span className="poster-fallback">{initials(media.title)}</span>}
      </div>

      <div className="card-body">
        <div className="card-badges">
          <span className={`badge badge-${type}`}>{type === 'movie' ? 'Movie' : 'TV'}</span>
          {type === 'show' && ongoing !== null && (
            <span className="badge badge-status">{ongoing ? 'Aired seasons' : 'Full series'}</span>
          )}
        </div>
        <h1 className="card-title">{media.title}</h1>
        <div className="card-meta">
          {media.year ?? '—'}
          {media.genres?.length ? ` · ${media.genres.slice(0, 3).join(', ')}` : ''}
        </div>
        {media.overview && <p className="card-overview">{media.overview}</p>}
      </div>
    </article>
  )
}
