// Small presentational building blocks for the student and staff screens.
import ThemeToggle from './ThemeToggle'

export function AppShell({ section, right, children }) {
  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#/">
          IITD Library {section && <small>{section}</small>}
        </a>
        <div className="app-header-right">
          {right}
          <ThemeToggle />
        </div>
      </header>
      <div className="app-main">{children}</div>
    </div>
  )
}

export function ErrorAlert({ error }) {
  if (!error) return null
  return (
    <div className="alert" role="alert">
      {error.message}
      {Array.isArray(error.details) && error.details.length > 0 && (
        <ul>
          {error.details.map((d) => (
            <li key={d.path + d.message}>
              {String(d.path).replace(/^body\./, '')}: {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DataTable({ columns, rows, loading, empty = 'Nothing to show.' }) {
  return (
    <div className="table-wrap">
      {!rows ? (
        <div className="empty">{loading === false ? empty : 'Loading…'}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id || r.id}>
                {columns.map((c) => (
                  <td
                    key={c.label}
                    className={c.wrap ? 'wrap' : c.clip ? 'clip' : undefined}
                    title={c.clip ? c.title?.(r) : undefined}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function Pager({ data, page, setPage }) {
  if (!data) return null
  return (
    <div className="pager">
      <span>
        {data.total} result{data.total === 1 ? '' : 's'} · page {data.page} of {data.totalPages}
      </span>
      <button
        className="btn btn-outline btn-sm"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        Previous
      </button>
      <button
        className="btn btn-outline btn-sm"
        disabled={page >= data.totalPages}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
    </div>
  )
}

/** Restrained status label: solid = needs attention / in progress, muted = finished. */
export function StatusBadge({ value }) {
  const solid = ['inside', 'rejected', 'inactive', 'disabled', 'revoked'].includes(value)
  const muted = ['completed', 'info'].includes(value)
  return (
    <span className={`badge${solid ? ' badge-solid' : muted ? ' badge-muted' : ''}`}>{value}</span>
  )
}

export function OccupancyStats({ occupancy }) {
  if (!occupancy) return null
  return (
    <div className="stats">
      <div className="stat">
        <strong>{occupancy.available}</strong>
        <span>Seats free</span>
      </div>
      <div className="stat">
        <strong>{occupancy.occupied}</strong>
        <span>Occupied</span>
      </div>
      <div className="stat">
        <strong>{occupancy.reserved}</strong>
        <span>On hold</span>
      </div>
      <div className="stat">
        <strong>{occupancy.capacity}</strong>
        <span>Capacity</span>
      </div>
    </div>
  )
}

export function LiveBadge({ connected }) {
  return (
    <span className="badge" title={connected ? 'Receiving live updates' : 'Reconnecting'}>
      <span className={`dot${connected ? ' is-on' : ''}`} />
      {connected ? 'Live' : 'Offline'}
    </span>
  )
}
