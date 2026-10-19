import { useCallback, useEffect, useState } from 'react'
import { SOCKET_EVENTS } from '@shared/libraryStates.mjs'
import { GRID } from '@shared/libraryLayout.mjs'
import { usePortalSession } from '@shared/ui/usePortalSession'
import { useAsync } from '@shared/ui/useAsync'
import { formatDateTime } from '@shared/ui/time'
import { AppShell, DataTable, ErrorAlert, Pager, StatusBadge } from '../components/ui'
import LiveMap from '../components/LiveMap'

const SECTIONS = [
  ['map', 'Live map'],
  ['sessions', 'Visits'],
  ['logs', 'Audit logs'],
  ['students', 'Students'],
  ['cards', 'RFID cards'],
  ['terminals', 'Gate terminals'],
  ['tables', 'Tables']
]

export default function StaffPortal() {
  const portal = usePortalSession('staff')
  const staff = portal.user
  return (
    <AppShell
      section="Staff"
      right={
        staff ? (
          <>
            <span className="muted">
              {staff.name} · {staff.role}
            </span>
            <button className="btn btn-outline btn-sm" onClick={portal.logout}>
              Sign out
            </button>
          </>
        ) : (
          <a className="btn btn-ghost btn-sm" href="#/">
            Back
          </a>
        )
      }
    >
      {staff ? (
        <Console portal={portal} />
      ) : (
        <StaffLogin api={portal.api} onSignedIn={portal.save} />
      )}
    </AppShell>
  )
}

function StaffLogin({ api, onSignedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const data = await api.post('/api/admin/login', { email, password })
      onSignedIn({ token: data.token, user: data.staff })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth">
      <div className="auth-card">
        <div>
          <h1>Staff sign in</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            For library staff and administrators. Accounts are created by an administrator.
          </p>
        </div>
        <form className="panel form" onSubmit={submit}>
          <label className="field">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <ErrorAlert error={error} />
          <button className="btn btn-block" disabled={busy || !api}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Console({ portal }) {
  const [section, setSection] = useState('map')
  const { api, socket } = portal
  const isAdmin = portal.user.role === 'admin'

  useEffect(() => {
    if (!socket) return undefined
    const sub = () => socket.emit(SOCKET_EVENTS.ADMIN_SUBSCRIBE, {}, () => {})
    socket.on('connect', sub)
    if (socket.connected) sub()
    return () => socket.off('connect', sub)
  }, [socket])

  return (
    <div className="console">
      <nav className="side-nav" aria-label="Staff sections">
        <div className="side-nav-label">Library</div>
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            className={section === id ? 'is-on' : ''}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="console-main">
        <div className="page">
          {section === 'map' && <LiveMap api={api} socket={socket} title="Live occupancy" />}
          {section === 'sessions' && <SessionsSection api={api} socket={socket} />}
          {section === 'logs' && <LogsSection api={api} socket={socket} />}
          {section === 'students' && <StudentsSection api={api} isAdmin={isAdmin} />}
          {section === 'cards' && <CardsSection api={api} />}
          {section === 'terminals' && <TerminalsSection api={api} isAdmin={isAdmin} />}
          {section === 'tables' && <TablesSection api={api} isAdmin={isAdmin} />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Paginated GET with filters. */
function usePaged(api, path, filters) {
  const [page, setPage] = useState(1)
  const key = JSON.stringify(filters)
  const fetcher = useCallback(
    () => api.get(path, { ...JSON.parse(key), page, limit: 25 }),
    [api, path, key, page]
  )
  const { data, error, loading, reload, setData } = useAsync(api ? fetcher : null)
  return { data, error, loading, page, setPage, reload, setData }
}

function useFilters(initial) {
  const [draft, setDraft] = useState(initial)
  const [applied, setApplied] = useState(initial)
  const bind = (k) => ({
    value: draft[k],
    onChange: (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  })
  return { applied, bind, apply: () => setApplied(draft) }
}

// Date inputs give local dates; the API expects ISO timestamps.
function toIsoRange(filters) {
  const out = { ...filters }
  if (filters.from) out.from = new Date(`${filters.from}T00:00:00`).toISOString()
  if (filters.to) out.to = new Date(`${filters.to}T23:59:59.999`).toISOString()
  return out
}

function Head({ title, description, children }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  )
}

function FilterBar({ onApply, children }) {
  return (
    <form
      className="toolbar"
      onSubmit={(e) => {
        e.preventDefault()
        onApply()
      }}
    >
      {children}
      <button className="btn btn-sm" type="submit">
        Apply
      </button>
    </form>
  )
}

function studentLabel(s) {
  return s?.entryNumber ? `${s.entryNumber} · ${s.name}` : '—'
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function SessionsSection({ api, socket }) {
  const f = useFilters({ status: '', entryNumber: '', from: '', to: '' })
  const paged = usePaged(api, '/api/admin/sessions', toIsoRange(f.applied))
  const { reload } = paged
  useEffect(() => {
    if (!socket) return undefined
    socket.on(SOCKET_EVENTS.SESSION_UPDATED, reload)
    return () => socket.off(SOCKET_EVENTS.SESSION_UPDATED, reload)
  }, [socket, reload])

  return (
    <>
      <Head title="Visits" description="Library sessions recorded by the entry and exit gates." />
      <FilterBar
        onApply={() => {
          paged.setPage(1)
          f.apply()
        }}
      >
        <label className="field">
          Status
          <select {...f.bind('status')}>
            <option value="">Any</option>
            <option value="inside">Inside</option>
            <option value="hold">On hold</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <label className="field">
          Entry number
          <input {...f.bind('entryNumber')} />
        </label>
        <label className="field">
          From
          <input type="date" {...f.bind('from')} />
        </label>
        <label className="field">
          To
          <input type="date" {...f.bind('to')} />
        </label>
      </FilterBar>
      <ErrorAlert error={paged.error} />
      <DataTable
        rows={paged.data?.items}
        loading={!paged.error}
        empty="No visits match these filters."
        columns={[
          { label: 'Student', render: (r) => studentLabel(r.studentId) },
          { label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { label: 'Table', render: (r) => r.tableId?.tableCode || '—' },
          { label: 'Seat', render: (r) => r.seatId?.seatCode || '—' },
          { label: 'Entered', render: (r) => `${formatDateTime(r.entryTime)} · ${r.entryGateId}` },
          {
            label: 'Left',
            render: (r) => (r.exitTime ? `${formatDateTime(r.exitTime)} · ${r.exitGateId}` : '—')
          },
          { label: 'Hold until', render: (r) => formatDateTime(r.holdUntil) },
          { label: 'Ended', render: (r) => (r.endReason ? r.endReason.replace('_', ' ') : '—') }
        ]}
      />
      <Pager data={paged.data} page={paged.page} setPage={paged.setPage} />
    </>
  )
}

function LogsSection({ api, socket }) {
  const f = useFilters({
    action: '',
    outcome: '',
    terminalCode: '',
    entryNumber: '',
    from: '',
    to: ''
  })
  const paged = usePaged(api, '/api/admin/logs', toIsoRange(f.applied))
  const { page, setData } = paged
  const unfiltered = Object.values(f.applied).every((v) => !v)

  // Live tail: new entries are prepended while viewing the unfiltered first page.
  useEffect(() => {
    if (!socket || page !== 1 || !unfiltered) return undefined
    const onLog = (entry) =>
      setData((d) =>
        d && !d.items.some((i) => i._id === entry._id)
          ? { ...d, total: d.total + 1, items: [entry, ...d.items].slice(0, d.limit) }
          : d
      )
    socket.on(SOCKET_EVENTS.ADMIN_LOG, onLog)
    return () => socket.off(SOCKET_EVENTS.ADMIN_LOG, onLog)
  }, [socket, page, unfiltered, setData])

  return (
    <>
      <Head
        title="Audit logs"
        description="Entries, exits, holds, rejections and administrative actions."
      />
      <FilterBar
        onApply={() => {
          paged.setPage(1)
          f.apply()
        }}
      >
        <label className="field">
          Action (end with * for prefix)
          <input {...f.bind('action')} placeholder="gate.*" />
        </label>
        <label className="field">
          Outcome
          <select {...f.bind('outcome')}>
            <option value="">Any</option>
            <option value="success">Success</option>
            <option value="rejected">Rejected</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="field">
          Terminal
          <input {...f.bind('terminalCode')} placeholder="ENTRY-1" />
        </label>
        <label className="field">
          Entry number
          <input {...f.bind('entryNumber')} />
        </label>
        <label className="field">
          From
          <input type="date" {...f.bind('from')} />
        </label>
        <label className="field">
          To
          <input type="date" {...f.bind('to')} />
        </label>
      </FilterBar>
      <ErrorAlert error={paged.error} />
      <DataTable
        rows={paged.data?.items}
        loading={!paged.error}
        empty="No log entries match these filters."
        columns={[
          { label: 'Time', render: (r) => formatDateTime(r.createdAt) },
          { label: 'Action', render: (r) => <span className="mono">{r.action}</span> },
          { label: 'Outcome', render: (r) => <StatusBadge value={r.outcome} /> },
          { label: 'Actor', render: (r) => r.actorType },
          {
            label: 'Student',
            render: (r) =>
              r.studentId?.entryNumber ? studentLabel(r.studentId) : r.studentId ? '…' : '—'
          },
          { label: 'Terminal', render: (r) => r.terminalCode || '—' },
          { label: 'Reason', render: (r) => r.reason || '—' },
          {
            label: 'Details',
            clip: true,
            title: (r) => (r.details ? JSON.stringify(r.details) : ''),
            render: (r) => {
              const d = r.details && Object.keys(r.details).length ? JSON.stringify(r.details) : ''
              return <span className="muted mono">{d}</span>
            }
          }
        ]}
      />
      <Pager data={paged.data} page={paged.page} setPage={paged.setPage} />
    </>
  )
}

function StudentsSection({ api, isAdmin }) {
  const f = useFilters({ q: '' })
  const paged = usePaged(api, '/api/admin/students', f.applied)
  const [actionError, setActionError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  async function toggle(student) {
    setActionError(null)
    setBusyId(student._id)
    try {
      await api.patch(`/api/admin/students/${student._id}`, { isActive: !student.isActive })
      paged.reload()
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <Head title="Students" description="Registered students and their library access." />
      <FilterBar
        onApply={() => {
          paged.setPage(1)
          f.apply()
        }}
      >
        <label className="field">
          Search name, email or entry number
          <input {...f.bind('q')} style={{ width: 280 }} />
        </label>
      </FilterBar>
      <ErrorAlert error={paged.error || actionError} />
      <DataTable
        rows={paged.data?.items}
        loading={!paged.error}
        empty="No students found."
        columns={[
          { label: 'Entry number', render: (r) => <span className="mono">{r.entryNumber}</span> },
          { label: 'Name', render: (r) => r.name },
          { label: 'Email', render: (r) => r.email },
          { label: 'Programme', render: (r) => `${r.programme}, ${r.department}` },
          {
            label: 'Access',
            render: (r) => <StatusBadge value={r.isActive ? 'active' : 'inactive'} />
          },
          {
            label: '',
            render: (r) =>
              isAdmin && (
                <button
                  className="btn btn-outline btn-sm"
                  disabled={busyId === r._id}
                  onClick={() => toggle(r)}
                >
                  {r.isActive ? 'Deactivate' : 'Activate'}
                </button>
              )
          }
        ]}
      />
      <Pager data={paged.data} page={paged.page} setPage={paged.setPage} />
    </>
  )
}

function CardsSection({ api }) {
  const paged = usePaged(api, '/api/admin/cards', {})
  const [form, setForm] = useState({ entryNumber: '', cardUid: '', replaceExisting: false })
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  async function issue(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const card = await api.post('/api/admin/cards', form)
      setMessage({
        ok: true,
        text: `Card …${card.cardUidHint} issued to ${form.entryNumber.toUpperCase()}.`
      })
      setForm({ entryNumber: '', cardUid: '', replaceExisting: false })
      paged.reload()
    } catch (err) {
      setMessage({ ok: false, text: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function revoke(card) {
    setMessage(null)
    try {
      await api.patch(`/api/admin/cards/${card._id}/revoke`, { reason: 'Revoked by staff' })
      paged.reload()
    } catch (err) {
      setMessage({ ok: false, text: err.message })
    }
  }

  return (
    <>
      <Head
        title="RFID cards"
        description="Link library cards to students, or revoke lost cards."
      />
      <form className="panel toolbar" onSubmit={issue}>
        <label className="field">
          Entry number
          <input
            value={form.entryNumber}
            onChange={(e) => setForm({ ...form, entryNumber: e.target.value })}
            required
          />
        </label>
        <label className="field">
          Card UID (hex)
          <input
            className="mono"
            value={form.cardUid}
            onChange={(e) => setForm({ ...form, cardUid: e.target.value })}
            required
          />
        </label>
        <label className="check" style={{ height: 36 }}>
          <input
            type="checkbox"
            checked={form.replaceExisting}
            onChange={(e) => setForm({ ...form, replaceExisting: e.target.checked })}
          />
          Replace the current card
        </label>
        <button className="btn btn-sm" disabled={busy}>
          Issue card
        </button>
      </form>
      {message && <div className={`alert${message.ok ? ' alert-quiet' : ''}`}>{message.text}</div>}
      <ErrorAlert error={paged.error} />
      <DataTable
        rows={paged.data?.items}
        loading={!paged.error}
        empty="No cards registered."
        columns={[
          { label: 'Card', render: (r) => <span className="mono">…{r.cardUidHint}</span> },
          { label: 'Student', render: (r) => studentLabel(r.studentId) },
          { label: 'Issued', render: (r) => formatDateTime(r.issuedAt) },
          {
            label: 'Status',
            render: (r) =>
              r.isActive ? <StatusBadge value="active" /> : <StatusBadge value="revoked" />
          },
          { label: 'Revoked', render: (r) => formatDateTime(r.revokedAt) },
          {
            label: '',
            render: (r) =>
              r.isActive && (
                <button className="btn btn-outline btn-sm" onClick={() => revoke(r)}>
                  Revoke
                </button>
              )
          }
        ]}
      />
      <Pager data={paged.data} page={paged.page} setPage={paged.setPage} />
    </>
  )
}

function TerminalsSection({ api, isAdmin }) {
  const fetcher = useCallback(async () => (await api.get('/api/admin/terminals')).items, [api])
  const { data: items, error: loadError, reload } = useAsync(fetcher)
  const [error, setError] = useState(null)
  const [secret, setSecret] = useState(null)
  const [form, setForm] = useState({ terminalCode: '', gateType: 'entry', name: '' })

  async function run(fn) {
    setError(null)
    try {
      await fn()
      reload()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <>
      <Head
        title="Gate terminals"
        description="Entry and exit gate devices allowed to submit card scans."
      />
      {secret && (
        <div className="alert" role="status">
          <strong>New key for {secret.terminalCode}.</strong> Copy it now — it will not be shown
          again.
          <div className="secret">{secret.terminalKey}</div>
          <button className="btn btn-outline btn-sm" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}
      {isAdmin && (
        <form
          className="panel toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            run(async () => {
              const r = await api.post('/api/admin/terminals', form)
              setSecret({ terminalCode: r.terminal.terminalCode, terminalKey: r.terminalKey })
              setForm({ terminalCode: '', gateType: 'entry', name: '' })
            })
          }}
        >
          <label className="field">
            Code
            <input
              value={form.terminalCode}
              onChange={(e) => setForm({ ...form, terminalCode: e.target.value })}
              placeholder="ENTRY-2"
              required
            />
          </label>
          <label className="field">
            Type
            <select
              value={form.gateType}
              onChange={(e) => setForm({ ...form, gateType: e.target.value })}
            >
              <option value="entry">Entry</option>
              <option value="exit">Exit</option>
            </select>
          </label>
          <label className="field">
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <button className="btn btn-sm">Register terminal</button>
        </form>
      )}
      <ErrorAlert error={error || loadError} />
      <DataTable
        rows={items}
        loading={!loadError}
        empty="No terminals registered."
        columns={[
          { label: 'Code', render: (r) => <span className="mono">{r.terminalCode}</span> },
          { label: 'Type', render: (r) => r.gateType },
          { label: 'Name', render: (r) => r.name },
          { label: 'Last seen', render: (r) => formatDateTime(r.lastSeenAt) },
          { label: 'Key rotated', render: (r) => formatDateTime(r.credentialRotatedAt) },
          {
            label: 'Status',
            render: (r) => <StatusBadge value={r.isActive ? 'active' : 'disabled'} />
          },
          {
            label: '',
            render: (r) =>
              isAdmin && (
                <div className="row-actions">
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() =>
                      run(() =>
                        api.patch(`/api/admin/terminals/${r._id}`, { isActive: !r.isActive })
                      )
                    }
                  >
                    {r.isActive ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() =>
                      run(async () => {
                        const res = await api.post(`/api/admin/terminals/${r._id}/rotate-key`)
                        setSecret({ terminalCode: r.terminalCode, terminalKey: res.terminalKey })
                      })
                    }
                  >
                    Rotate key
                  </button>
                </div>
              )
          }
        ]}
      />
    </>
  )
}

const EMPTY_TABLE = { tableCode: '', name: '', capacity: 2, col: 0, row: 0, cols: 1, rows: 1 }

function TablesSection({ api, isAdmin }) {
  const fetcher = useCallback(async () => (await api.get('/api/library/tables')).tables, [api])
  const { data: tables, error: loadError, reload } = useAsync(fetcher)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(EMPTY_TABLE)
  const [edits, setEdits] = useState({})

  async function run(fn) {
    setError(null)
    try {
      await fn()
      reload()
    } catch (err) {
      setError(err)
    }
  }

  const num = (k) => ({
    type: 'number',
    min: 0,
    value: form[k],
    onChange: (e) => setForm({ ...form, [k]: Number(e.target.value) })
  })

  return (
    <>
      <Head
        title="Tables"
        description="Active tables on the floor plan. Positions use the library grid (columns × rows)."
      />
      {isAdmin && (
        <form
          className="panel toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            run(async () => {
              await api.post('/api/admin/tables', {
                tableCode: form.tableCode,
                name: form.name,
                capacity: form.capacity,
                location: {
                  x: form.col * GRID.cellWidth,
                  y: form.row * GRID.cellHeight,
                  width: form.cols * GRID.cellWidth,
                  height: form.rows * GRID.cellHeight
                }
              })
              setForm(EMPTY_TABLE)
            })
          }}
        >
          <label className="field">
            Code
            <input
              value={form.tableCode}
              onChange={(e) => setForm({ ...form, tableCode: e.target.value })}
              required
              style={{ width: 90 }}
            />
          </label>
          <label className="field">
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            Seats
            <input {...num('capacity')} min={1} max={20} style={{ width: 70 }} />
          </label>
          <label className="field">
            Column
            <input {...num('col')} max={GRID.columns - 1} style={{ width: 70 }} />
          </label>
          <label className="field">
            Row
            <input {...num('row')} max={GRID.rows - 1} style={{ width: 70 }} />
          </label>
          <label className="field">
            Width (cols)
            <input {...num('cols')} min={1} style={{ width: 70 }} />
          </label>
          <label className="field">
            Height (rows)
            <input {...num('rows')} min={1} style={{ width: 70 }} />
          </label>
          <button className="btn btn-sm">Add table</button>
        </form>
      )}
      <ErrorAlert error={error || loadError} />
      <DataTable
        rows={tables}
        loading={!loadError}
        empty="No active tables."
        columns={[
          { label: 'Code', render: (r) => <span className="mono">{r.tableCode}</span> },
          { label: 'Name', render: (r) => r.name },
          {
            label: 'Seats taken',
            render: (r) => `${r.counts.occupied + r.counts.reserved}/${r.capacity}`
          },
          { label: 'On hold', render: (r) => r.counts.reserved },
          {
            label: 'Position',
            render: (r) =>
              `col ${r.location.x / GRID.cellWidth}, row ${r.location.y / GRID.cellHeight}`
          },
          {
            label: 'Capacity',
            render: (r) =>
              isAdmin ? (
                <div className="row-actions">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    aria-label={`Capacity of ${r.tableCode}`}
                    value={edits[r.id] ?? r.capacity}
                    onChange={(e) => setEdits({ ...edits, [r.id]: Number(e.target.value) })}
                    style={{ width: 64, height: 28 }}
                  />
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={edits[r.id] === undefined || edits[r.id] === r.capacity}
                    onClick={() =>
                      run(async () => {
                        await api.patch(`/api/admin/tables/${r.id}`, { capacity: edits[r.id] })
                        setEdits((prev) => {
                          const next = { ...prev }
                          delete next[r.id]
                          return next
                        })
                      })
                    }
                  >
                    Save
                  </button>
                </div>
              ) : (
                r.capacity
              )
          },
          {
            label: '',
            render: (r) =>
              isAdmin && (
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() =>
                    run(() => api.patch(`/api/admin/tables/${r.id}`, { isActive: false }))
                  }
                >
                  Deactivate
                </button>
              )
          }
        ]}
      />
    </>
  )
}
