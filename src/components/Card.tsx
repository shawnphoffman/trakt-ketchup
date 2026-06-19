import type { FeedItem } from '../lib/trakt'

const ONGOING = new Set(['returning series', 'in production', 'planned'])

export function Card({ item }: { item: FeedItem }) {
  const { media, type } = item
  const ongoing = type === 'show' && media.status ? ONGOING.has(media.status) : false

  return (
    <div className="card">
      <div className="card-badges">
        <span className={`badge badge-${type}`}>{type === 'movie' ? 'Movie' : 'TV'}</span>
        {type === 'show' && (
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
  )
}
