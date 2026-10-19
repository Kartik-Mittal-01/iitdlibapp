import { MAP_FIXTURES } from '../libraryLayout.mjs'

// Seats that cannot be taken right now: occupied plus reserved (on hold),
// exactly as the backend's seat statuses define them.
export function seatsTaken(table) {
  return table.counts.occupied + table.counts.reserved
}

/**
 * Free seats at a table: capacity - (occupied + reserved), never more than the
 * backend's own count of allocatable seats. Returns null when the data is
 * missing or malformed, so the table is shown as unknown rather than guessed.
 */
export function availableSeats(table) {
  const c = table?.counts
  const capacity = table?.capacity
  if (!c || !Number.isFinite(capacity)) return null
  if (![c.available, c.occupied, c.reserved].every(Number.isFinite)) return null
  return Math.max(0, Math.min(capacity - seatsTaken(table), c.available))
}

// 'available' (green), 'full' (red) or 'unknown' (neutral).
export function availabilityState(table) {
  const free = availableSeats(table)
  if (free === null) return 'unknown'
  return free > 0 ? 'available' : 'full'
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function bounds(rects) {
  if (!rects.length) return { x: 0, y: 0, width: 100, height: 100 }
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.width))
  const maxY = Math.max(...rects.map((r) => r.y + r.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const INSET = 4
const FONT = 17

/**
 * Library floor plan at table level. Tables, positions and counts come from the
 * backend map (GET /api/library/map + Socket.IO updates); only the non-seating
 * fixtures (stairs, entry gate) come from the shared reference layout.
 * Each table shows its ID and seats taken / capacity.
 */
export default function TableMap({
  map,
  selectable = false,
  selectedTableId = null,
  highlightTableId = null,
  onSelectTable,
  legend = true
}) {
  if (!map) return null
  const tables = map.tables
  const rects = tables.map((t) => t.location)
  // Fixtures belong to the reference layout; skip any that would collide with a table.
  const fixtures = MAP_FIXTURES.filter((f) => !rects.some((r) => overlaps(f, r)))
  const b = bounds([...rects, ...fixtures])
  const pad = 8

  return (
    <div className="tm">
      <svg
        className="tm-svg"
        viewBox={`${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Library floor plan"
      >
        <defs>
          <pattern
            id="tm-hatch"
            width="10"
            height="10"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="10" className="tm-hatch-line" />
          </pattern>
        </defs>

        {fixtures.map((f) => (
          <g key={f.id} className="tm-fixture" aria-hidden="true">
            <rect
              x={f.x + INSET}
              y={f.y + INSET}
              width={f.width - INSET * 2}
              height={f.height - INSET * 2}
            />
            <text
              x={f.x + f.width / 2}
              y={f.y + f.height / 2}
              dominantBaseline="central"
              textAnchor="middle"
            >
              {f.label}
            </text>
          </g>
        ))}

        {tables.length === 0 && (
          <text
            x={b.x + b.width / 2}
            y={b.y + b.height / 2}
            textAnchor="middle"
            className="tm-empty"
          >
            No tables are set up.
          </text>
        )}

        {tables.map((t) => {
          const { x, y, width, height } = t.location
          const state = availabilityState(t)
          const known = state !== 'unknown'
          const taken = known ? seatsTaken(t) : null
          const canPick = selectable && state === 'available'
          const selected = t.id === selectedTableId
          const highlighted = t.id === highlightTableId
          const tall = height >= 70
          const count = known ? `${taken}/${t.capacity}` : `–/${t.capacity}`
          const label = known
            ? `Table ${t.tableCode}, ${taken} of ${t.capacity} seats taken, ${
                state === 'full' ? 'full' : `${availableSeats(t)} available`
              }`
            : `Table ${t.tableCode}, availability unknown`
          const select = () => canPick && onSelectTable?.(t)
          return (
            <g
              key={t.id}
              className={[
                'tm-table',
                `is-${state}`,
                canPick && 'is-selectable',
                (selected || highlighted) && 'is-selected'
              ]
                .filter(Boolean)
                .join(' ')}
              role={selectable ? 'button' : 'img'}
              tabIndex={canPick ? 0 : undefined}
              aria-label={label}
              aria-pressed={selectable ? selected : undefined}
              aria-disabled={selectable && !canPick ? true : undefined}
              onClick={select}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select()
                }
              }}
            >
              <title>{label}</title>
              <rect
                x={x + INSET}
                y={y + INSET}
                width={width - INSET * 2}
                height={height - INSET * 2}
                rx="3"
              />
              {tall ? (
                <>
                  <text
                    x={x + width / 2}
                    y={y + height / 2 - FONT * 0.6}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="tm-id"
                  >
                    {t.tableCode}
                  </text>
                  <text
                    x={x + width / 2}
                    y={y + height / 2 + FONT * 0.7}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="tm-count"
                  >
                    {count}
                  </text>
                </>
              ) : (
                <>
                  <text
                    x={x + INSET + 8}
                    y={y + height / 2}
                    dominantBaseline="central"
                    className="tm-id"
                  >
                    {t.tableCode}
                  </text>
                  <text
                    x={x + width - INSET - 8}
                    y={y + height / 2}
                    dominantBaseline="central"
                    textAnchor="end"
                    className="tm-count"
                  >
                    {count}
                  </text>
                </>
              )}
            </g>
          )
        })}
      </svg>
      {legend && (
        <div className="tm-legend" aria-hidden="true">
          <span>
            <i className="tm-swatch is-available" /> Seats available
          </span>
          <span>
            <i className="tm-swatch is-full" /> Table full
          </span>
          {selectable && (
            <span>
              <i className="tm-swatch is-selected" /> Selected
            </span>
          )}
          <span className="tm-legend-note">Numbers show seats taken / capacity</span>
        </div>
      )}
    </div>
  )
}
