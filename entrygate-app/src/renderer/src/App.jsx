import { useEffect, useReducer, useRef } from 'react'
import { GATE_NEXT_ACTION, SEAT_STATUS, SOCKET_EVENTS } from '@shared/libraryStates.mjs'
import TableMap, { availableSeats } from '@shared/ui/TableMap'
import { Antenna, NoticeMark, SuccessTick } from '@shared/ui/KioskGraphics'
import { Countdown, DevScan, KioskStatus, terminalProblem } from '@shared/ui/KioskParts'
import { useTerminal } from '@shared/ui/useTerminal'
import { useLibraryMap } from '@shared/ui/useLibraryMap'
import { formatTime } from '@shared/ui/time'

// Kiosk timings (UI only; the server's own scan-token expiry still applies).
const SELECT_SECONDS = 10
const SUCCESS_MS = 3000
const ERROR_MS = 2000
const SUBMIT_TIMEOUT_MS = 15000

// Phases: idle -> scanning -> selecting -> submitting -> success | error -> idle.
// `seq` identifies the current scan; every timer and response carries it, so
// anything belonging to an earlier scan is ignored.
const initial = { phase: 'idle', seq: 0, scan: null, deadline: null, tableId: null, seatId: null }

function reducer(state, a) {
  switch (a.type) {
    case 'SCANNING':
      if (state.phase === 'selecting' || state.phase === 'submitting') return state
      return { ...initial, phase: 'scanning', seq: state.seq + 1 }
    case 'SCAN': {
      // Never abandon a confirmation that is already on its way to the server.
      if (state.phase === 'submitting') return state
      const seq = state.phase === 'scanning' ? state.seq : state.seq + 1
      const s = a.scan
      if (!s.accepted) return { ...initial, seq, phase: 'error', message: s.message }
      if (
        s.nextAction === GATE_NEXT_ACTION.SELECT_SEAT ||
        s.nextAction === GATE_NEXT_ACTION.RESUME_HOLD
      ) {
        return {
          ...initial,
          seq,
          phase: 'selecting',
          scan: s,
          deadline: a.now + SELECT_SECONDS * 1000
        }
      }
      return {
        ...initial,
        seq,
        phase: 'error',
        message: 'This card cannot be used at the entry gate.'
      }
    }
    case 'SCAN_FAILED':
      if (state.phase !== 'scanning') return state
      return { ...initial, seq: state.seq, phase: 'error', message: a.message }
    case 'SELECT_TABLE':
      if (state.phase !== 'selecting') return state
      return { ...state, tableId: a.tableId, seatId: null }
    case 'SELECT_SEAT':
      if (state.phase !== 'selecting') return state
      return { ...state, seatId: a.seatId }
    case 'SUBMIT':
      if (a.seq !== state.seq || state.phase !== 'selecting') return state
      return { ...state, phase: 'submitting' }
    case 'SUCCEEDED':
      if (a.seq !== state.seq || state.phase !== 'submitting') return state
      return { ...state, phase: 'success', result: a.result }
    case 'FAILED':
      if (a.seq !== state.seq || state.phase !== 'submitting') return state
      return { ...initial, seq: state.seq, phase: 'error', message: a.message }
    case 'TIMEOUT':
      if (a.seq !== state.seq || a.phase !== state.phase) return state
      if (state.phase === 'submitting') {
        return {
          ...initial,
          seq: state.seq,
          phase: 'error',
          message: 'No response from the library server. Please tap your card again.'
        }
      }
      return { ...initial, seq: state.seq }
    case 'CANCEL':
      if (state.phase !== 'selecting') return state
      return { ...initial, seq: state.seq }
    default:
      return state
  }
}

function phaseTimeout(state) {
  switch (state.phase) {
    case 'selecting':
      return Math.max(0, state.deadline - Date.now())
    case 'scanning':
    case 'submitting':
      return SUBMIT_TIMEOUT_MS
    case 'success':
      return SUCCESS_MS
    case 'error':
      return ERROR_MS
    default:
      return null
  }
}

export default function App() {
  const { config, terminal, authError, api, socket, connected } = useTerminal()
  // Kept live in the background so the map is current the moment a card is accepted.
  const live = useLibraryMap(api, socket)
  const [state, dispatch] = useReducer(reducer, initial)
  const lastScanKey = useRef(null)
  const submittedSeq = useRef(0)
  const { phase, seq, deadline } = state

  // One timer per (phase, scan); cleared on every transition and on unmount.
  useEffect(() => {
    const ms = phaseTimeout({ phase, deadline })
    if (ms === null) return undefined
    const id = setTimeout(() => dispatch({ type: 'TIMEOUT', seq, phase }), ms)
    return () => clearTimeout(id)
  }, [phase, seq, deadline])

  const acceptScan = (payload) => {
    const key = `${payload.terminalCode}|${payload.scannedAt}`
    if (key === lastScanKey.current) return // same scan via HTTP and Socket.IO
    lastScanKey.current = key
    dispatch({ type: 'SCAN', scan: payload, now: Date.now() })
  }
  const acceptScanRef = useRef(acceptScan)
  useEffect(() => {
    acceptScanRef.current = acceptScan
  })

  // Scans from the physical reader arrive as gate:result on this terminal's room.
  useEffect(() => {
    if (!socket) return undefined
    const onGate = (p) => {
      if (p?.stage === 'scan') acceptScanRef.current(p)
    }
    socket.on(SOCKET_EVENTS.GATE_RESULT, onGate)
    return () => socket.off(SOCKET_EVENTS.GATE_RESULT, onGate)
  }, [socket])

  const table = live.map?.tables.find((t) => t.id === state.tableId) || null
  // Selections are checked against the live map: a table or seat taken in the
  // meantime simply stops being selected (the server re-checks on confirm).
  const usableTable = table && availableSeats(table) > 0 ? table : null
  const seat = usableTable?.seats.find((s) => s.id === state.seatId)
  const usableSeat = seat && seat.status === SEAT_STATUS.AVAILABLE ? seat : null
  const resume = state.scan?.nextAction === GATE_NEXT_ACTION.RESUME_HOLD

  async function confirm() {
    if (phase !== 'selecting' || submittedSeq.current === seq) return
    if (!resume && !usableTable) return
    submittedSeq.current = seq
    const body = resume
      ? { scanToken: state.scan.scanToken }
      : {
          scanToken: state.scan.scanToken,
          tableId: usableTable.id,
          ...(usableSeat ? { seatId: usableSeat.id } : {})
        }
    dispatch({ type: 'SUBMIT', seq })
    try {
      const result = await api.post('/api/gate/entry', body)
      dispatch({ type: 'SUCCEEDED', seq, result })
    } catch (err) {
      dispatch({ type: 'FAILED', seq, message: err.message })
    }
  }

  const problem = terminalProblem(config, authError)

  return (
    <div className="kiosk">
      {(phase === 'idle' || phase === 'scanning') && (
        <div className="kiosk-center">
          <Antenna />
          <p className="kiosk-title">
            {problem ||
              (phase === 'scanning' ? 'Reading card…' : 'Tap your IIT Delhi library card')}
          </p>
        </div>
      )}

      {(phase === 'selecting' || phase === 'submitting') && resume && (
        <ResumeHold
          state={state}
          onConfirm={confirm}
          onCancel={() => dispatch({ type: 'CANCEL' })}
        />
      )}

      {(phase === 'selecting' || phase === 'submitting') && !resume && (
        <SeatSelection
          state={state}
          map={live.map}
          mapError={live.error}
          table={usableTable}
          seat={usableSeat}
          dispatch={dispatch}
          onConfirm={confirm}
        />
      )}

      {phase === 'success' && <Success result={state.result} />}

      {phase === 'error' && (
        <div className="kiosk-center" role="alert">
          <NoticeMark />
          <p className="kiosk-title">{state.message}</p>
        </div>
      )}

      {(phase === 'idle' || phase === 'scanning') && (
        <>
          <KioskStatus config={config} terminal={terminal} connected={connected} />
          {import.meta.env.DEV && api && (
            <DevScan
              api={api}
              onStart={() => dispatch({ type: 'SCANNING' })}
              onScan={acceptScan}
              onError={(message) => dispatch({ type: 'SCAN_FAILED', message })}
            />
          )}
        </>
      )}
    </div>
  )
}

function SeatSelection({ state, map, mapError, table, seat, dispatch, onConfirm }) {
  const submitting = state.phase === 'submitting'
  return (
    <div className="sel">
      <header className="sel-head">
        <h1>
          Welcome, {state.scan.student?.displayName}. <span className="muted">Choose a table.</span>
        </h1>
      </header>
      <main className="sel-map">
        {map ? (
          <TableMap
            map={map}
            selectable={!submitting}
            selectedTableId={table?.id}
            onSelectTable={(t) => dispatch({ type: 'SELECT_TABLE', tableId: t.id })}
          />
        ) : (
          <p className="muted">{mapError ? mapError.message : 'Loading map…'}</p>
        )}
      </main>
      <footer className="sel-confirm">
        <div className="sel-choice">
          <div className="sel-field">
            <span className="sel-label">Table</span>
            <span className="sel-value">{table ? table.tableCode : '—'}</span>
          </div>
          <div className="sel-field sel-seats">
            <span className="sel-label">Seat</span>
            {table ? (
              <div className="seat-picker" role="radiogroup" aria-label="Seat">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!seat}
                  className={`seat-chip seat-any${!seat ? ' is-on' : ''}`}
                  disabled={submitting}
                  onClick={() => dispatch({ type: 'SELECT_SEAT', seatId: null })}
                >
                  Any free
                </button>
                {table.seats.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={seat?.id === s.id}
                    aria-label={`Seat ${s.seatCode}${s.status !== SEAT_STATUS.AVAILABLE ? ' (taken)' : ''}`}
                    className={`seat-chip${seat?.id === s.id ? ' is-on' : ''}`}
                    disabled={submitting || s.status !== SEAT_STATUS.AVAILABLE}
                    onClick={() => dispatch({ type: 'SELECT_SEAT', seatId: s.id })}
                  >
                    {s.seatNumber}
                  </button>
                ))}
              </div>
            ) : (
              <span className="sel-value muted">Select a table on the map</span>
            )}
          </div>
        </div>
        <div className="sel-actions">
          <Countdown deadline={state.deadline} seconds={SELECT_SECONDS} paused={submitting} />
          <button
            className="btn btn-outline btn-lg"
            disabled={submitting}
            onClick={() => dispatch({ type: 'CANCEL' })}
          >
            Cancel
          </button>
          <button className="btn btn-lg" disabled={!table || submitting} onClick={onConfirm}>
            {submitting ? 'Confirming…' : 'Confirm seat'}
          </button>
        </div>
      </footer>
    </div>
  )
}

function ResumeHold({ state, onConfirm, onCancel }) {
  const submitting = state.phase === 'submitting'
  const v = state.scan.visit
  return (
    <div className="kiosk-center">
      <p className="kiosk-sub">Welcome back, {state.scan.student?.displayName}</p>
      <p className="kiosk-title">
        Your seat {v?.seatCode} is held until {formatTime(v?.holdUntil)}
      </p>
      <div className="sel-actions">
        <Countdown deadline={state.deadline} seconds={SELECT_SECONDS} paused={submitting} />
        <button className="btn btn-outline btn-lg" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-lg" disabled={submitting} onClick={onConfirm}>
          {submitting ? 'Confirming…' : 'Resume my seat'}
        </button>
      </div>
    </div>
  )
}

function Success({ result }) {
  return (
    <div className="kiosk-center" role="status">
      <SuccessTick />
      <p className="kiosk-title">
        {result.outcome === 'hold_resumed' ? 'Welcome back — seat resumed' : 'Entry successful'}
      </p>
      <dl className="result-detail">
        <div>
          <dt>Table</dt>
          <dd>{result.table?.tableCode}</dd>
        </div>
        <div>
          <dt>Seat</dt>
          <dd>{result.seat?.seatCode}</dd>
        </div>
      </dl>
    </div>
  )
}
