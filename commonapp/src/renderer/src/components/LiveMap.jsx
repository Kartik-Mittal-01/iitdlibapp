import TableMap from '@shared/ui/TableMap'
import { useLibraryMap } from '@shared/ui/useLibraryMap'
import { LiveBadge, OccupancyStats } from './ui'

/** Live table-level floor plan with occupancy, from REST + Socket.IO. */
export default function LiveMap({ api, socket, highlightTableCode, title = 'Library map' }) {
  const live = useLibraryMap(api, socket)
  const highlight = live.map?.tables.find((t) => t.tableCode === highlightTableCode)?.id
  return (
    <section className="panel map-panel">
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <h2>{title}</h2>
        <LiveBadge connected={Boolean(live.connected)} />
      </div>
      <OccupancyStats occupancy={live.occupancy} />
      {live.error && (
        <div className="alert" role="alert">
          {live.error.message}{' '}
          <button className="btn btn-outline btn-sm" onClick={live.reload}>
            Retry
          </button>
        </div>
      )}
      <div className="map-frame">
        {live.map ? (
          <TableMap map={live.map} highlightTableId={highlight} />
        ) : (
          !live.error && <div className="empty">Loading map…</div>
        )}
      </div>
    </section>
  )
}
