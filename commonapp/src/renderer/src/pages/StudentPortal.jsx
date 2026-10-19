import { useCallback, useEffect } from 'react'
import { SOCKET_EVENTS } from '@shared/libraryStates.mjs'
import { usePortalSession } from '@shared/ui/usePortalSession'
import { useAsync } from '@shared/ui/useAsync'
import { formatClock, formatTime, serverOffsetMs, useSecondsUntil } from '@shared/ui/time'
import { AppShell, ErrorAlert } from '../components/ui'
import LiveMap from '../components/LiveMap'
import StudentAuth from './StudentAuth'

export default function StudentPortal() {
  const portal = usePortalSession('student')
  const user = portal.user
  return (
    <AppShell
      section="Student"
      right={
        user ? (
          <>
            <span className="muted">{user.name}</span>
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
      {user ? (
        <StudentHome portal={portal} />
      ) : (
        <StudentAuth api={portal.api} onSignedIn={portal.save} />
      )}
    </AppShell>
  )
}

function StudentHome({ portal }) {
  const { api, socket, user } = portal
  // Only the signed-in student's own status; the server enforces this.
  const fetchStatus = useCallback(
    // receivedAt pairs the response's serverTime with the local clock (see serverOffsetMs).
    () =>
      api
        .get(`/api/gate/status/${encodeURIComponent(user.entryNumber)}`)
        .then((status) => ({ ...status, receivedAt: Date.now() })),
    [api, user.entryNumber]
  )
  const { data: status, error: statusError, reload } = useAsync(api ? fetchStatus : null)

  useEffect(() => {
    if (!socket) return undefined
    // Own-session changes arrive on this student's private room; refetch the summary.
    socket.on(SOCKET_EVENTS.SESSION_UPDATED, reload)
    socket.on('connect', reload)
    return () => {
      socket.off(SOCKET_EVENTS.SESSION_UPDATED, reload)
      socket.off('connect', reload)
    }
  }, [socket, reload])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Hello, {user.name.split(/\s+/)[0]}</h1>
          <p>Your library visit and live seat availability.</p>
        </div>
      </div>
      <div className="student-grid">
        <div className="student-side">
          <VisitPanel status={status} error={statusError} onHoldExpired={reload} />
          <section className="panel">
            <div className="panel-head">
              <h2>Your details</h2>
            </div>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{user.name}</dd>
              <dt>Entry number</dt>
              <dd className="mono">{user.entryNumber}</dd>
              <dt>Email</dt>
              <dd>{user.email}</dd>
              <dt>Programme</dt>
              <dd>{user.programme}</dd>
              <dt>Department</dt>
              <dd>{user.department}</dd>
            </dl>
          </section>
        </div>
        <LiveMap
          api={api}
          socket={socket}
          highlightTableCode={status?.state !== 'outside' ? status?.visit?.tableCode : null}
        />
      </div>
    </div>
  )
}

const STATE_LABEL = {
  outside: 'Not in the library',
  inside: 'Inside the library',
  hold: 'On a short break'
}

function VisitPanel({ status, error, onHoldExpired }) {
  const v = status?.visit
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Current visit</h2>
      </div>
      {error && <ErrorAlert error={error} />}
      {!error && !status && <p className="muted">Loading…</p>}
      {status && (
        <>
          <p className="visit-state">{STATE_LABEL[status.state] || status.state}</p>
          {status.state === 'outside' && (
            <p className="muted">Tap your library card at the entry gate to check in.</p>
          )}
          {status.state !== 'outside' && v && (
            <dl className="kv">
              <dt>Table</dt>
              <dd>{v.tableCode}</dd>
              <dt>Seat</dt>
              <dd>{v.seatCode}</dd>
              <dt>Checked in</dt>
              <dd>{formatTime(v.entryTime)}</dd>
              {status.state === 'hold' && (
                <>
                  <dt>Held until</dt>
                  <dd>{formatTime(v.holdUntil)}</dd>
                </>
              )}
            </dl>
          )}
          {status.state === 'hold' && v?.holdUntil && (
            // Keyed by the hold so it remounts (and reads the clock afresh) per hold.
            <HoldCountdown
              key={v.holdUntil}
              holdUntil={v.holdUntil}
              offsetMs={serverOffsetMs(status.serverTime, status.receivedAt)}
              onExpired={onHoldExpired}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * Live MM:SS countdown to the server-stored holdUntil. The backend decides when
 * the hold has expired: at 00:00 this only re-fetches the status (and keeps
 * re-fetching every few seconds until the backend reports the new state).
 */
function HoldCountdown({ holdUntil, offsetMs, onExpired }) {
  const seconds = useSecondsUntil(holdUntil, offsetMs)
  const expired = seconds === 0

  useEffect(() => {
    if (!expired) return undefined
    onExpired()
    const id = setInterval(onExpired, 3000)
    return () => clearInterval(id)
  }, [expired, onExpired])

  return (
    <div style={{ marginTop: 14 }}>
      <div className="hold-clock" role="timer" aria-label={`${formatClock(seconds)} remaining`}>
        {formatClock(seconds)}
      </div>
      <p className="muted">
        {expired
          ? 'Hold time is over. Updating your visit…'
          : 'Tap your card at the entry gate before then to keep your seat.'}
      </p>
    </div>
  )
}
