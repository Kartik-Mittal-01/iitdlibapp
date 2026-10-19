import { useEffect, useReducer, useRef } from 'react'
import {
  EXIT_MODES,
  GATE_NEXT_ACTION,
  HOLD_DURATION_MS,
  SOCKET_EVENTS
} from '@shared/libraryStates.mjs'
import { Antenna, NoticeMark, SuccessTick } from '@shared/ui/KioskGraphics'
import { Countdown, DevScan, KioskStatus, terminalProblem } from '@shared/ui/KioskParts'
import { useTerminal } from '@shared/ui/useTerminal'
import { formatTime } from '@shared/ui/time'

// Kiosk timings (UI only). The 15-minute hold itself is decided by the server.
const CHOOSE_SECONDS = 10
const SUCCESS_MS = 3000
const ERROR_MS = 2000
const SUBMIT_TIMEOUT_MS = 15000

// Phases: idle -> scanning -> choosing -> submitting -> success | error -> idle.
// `seq` identifies the current scan; timers and responses for older scans are ignored.
const initial = { phase: 'idle', seq: 0, scan: null, deadline: null, mode: null }

function reducer(state, a) {
  switch (a.type) {
    case 'SCANNING':
      if (state.phase === 'choosing' || state.phase === 'submitting') return state
      return { ...initial, phase: 'scanning', seq: state.seq + 1 }
    case 'SCAN': {
      if (state.phase === 'submitting') return state
      const seq = state.phase === 'scanning' ? state.seq : state.seq + 1
      const s = a.scan
      if (!s.accepted) {
        const held =
          s.code === 'ALREADY_ON_HOLD' && s.visit?.holdUntil
            ? `Your seat is held until ${formatTime(s.visit.holdUntil)}.`
            : null
        return { ...initial, seq, phase: 'error', message: s.message, detail: held }
      }
      if (s.nextAction === GATE_NEXT_ACTION.CHOOSE_EXIT) {
        return {
          ...initial,
          seq,
          phase: 'choosing',
          scan: s,
          deadline: a.now + CHOOSE_SECONDS * 1000
        }
      }
      return {
        ...initial,
        seq,
        phase: 'error',
        message: 'This card cannot be used at the exit gate.'
      }
    }
    case 'SCAN_FAILED':
      if (state.phase !== 'scanning') return state
      return { ...initial, seq: state.seq, phase: 'error', message: a.message }
    case 'SUBMIT':
      if (a.seq !== state.seq || state.phase !== 'choosing') return state
      return { ...state, phase: 'submitting', mode: a.mode }
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
      if (state.phase !== 'choosing') return state
      return { ...initial, seq: state.seq }
    default:
      return state
  }
}

function phaseTimeout({ phase, deadline }) {
  switch (phase) {
    case 'choosing':
      return Math.max(0, deadline - Date.now())
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

  useEffect(() => {
    if (!socket) return undefined
    const onGate = (p) => {
      if (p?.stage === 'scan') acceptScanRef.current(p)
    }
    socket.on(SOCKET_EVENTS.GATE_RESULT, onGate)
    return () => socket.off(SOCKET_EVENTS.GATE_RESULT, onGate)
  }, [socket])

  async function choose(mode) {
    if (phase !== 'choosing' || submittedSeq.current === seq) return
    submittedSeq.current = seq
    dispatch({ type: 'SUBMIT', seq, mode })
    try {
      const result = await api.post('/api/gate/exit', { scanToken: state.scan.scanToken, mode })
      dispatch({ type: 'SUCCEEDED', seq, result })
    } catch (err) {
      dispatch({ type: 'FAILED', seq, message: err.message })
    }
  }

  const problem = terminalProblem(config, authError)
  const holdMinutes = state.scan?.holdDurationMinutes || HOLD_DURATION_MS / 60000

  return (
    <div className="kiosk">
      {(phase === 'idle' || phase === 'scanning') && (
        <div className="kiosk-center">
          <Antenna />
          <p className="kiosk-title">
            {problem || (phase === 'scanning' ? 'Reading card…' : 'Tap your library card to exit')}
          </p>
        </div>
      )}

      {(phase === 'choosing' || phase === 'submitting') && (
        <div className="kiosk-center">
          <div>
            <p className="kiosk-sub">Goodbye, {state.scan.student?.displayName}</p>
            <p className="kiosk-title">Seat {state.scan.visit?.seatCode}. How are you leaving?</p>
          </div>
          <div className="choices">
            <button
              className="choice"
              disabled={phase === 'submitting'}
              onClick={() => choose(EXIT_MODES.HOLD)}
            >
              <span className="choice-title">
                {phase === 'submitting' && state.mode === EXIT_MODES.HOLD
                  ? 'Holding…'
                  : `Hold — ${holdMinutes} minutes`}
              </span>
              <span className="choice-sub">Keep my seat for a short break</span>
            </button>
            <button
              className="choice choice-primary"
              disabled={phase === 'submitting'}
              onClick={() => choose(EXIT_MODES.EXIT)}
            >
              <span className="choice-title">
                {phase === 'submitting' && state.mode === EXIT_MODES.EXIT
                  ? 'Checking out…'
                  : 'Leave now'}
              </span>
              <span className="choice-sub">Release my seat</span>
            </button>
          </div>
          <div className="sel-actions">
            <Countdown
              deadline={deadline}
              seconds={CHOOSE_SECONDS}
              paused={phase === 'submitting'}
            />
            <button
              className="btn btn-outline"
              disabled={phase === 'submitting'}
              onClick={() => dispatch({ type: 'CANCEL' })}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'success' && <Success result={state.result} holdMinutes={holdMinutes} />}

      {phase === 'error' && (
        <div className="kiosk-center" role="alert">
          <NoticeMark />
          <p className="kiosk-title">{state.message}</p>
          {state.detail && <p className="kiosk-sub">{state.detail}</p>}
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

function Success({ result, holdMinutes }) {
  const hold = result.outcome === 'hold_started'
  return (
    <div className="kiosk-center" role="status">
      <SuccessTick />
      <div>
        <p className="kiosk-title">
          {hold ? 'You have exited temporarily' : `Goodbye, ${result.student?.displayName}`}
        </p>
        <p className="kiosk-sub">
          {hold
            ? `Seat ${result.seat?.seatCode} is held for ${holdMinutes} minutes, until ${formatTime(result.session?.holdUntil)}.`
            : `Exit recorded. Seat ${result.seat?.seatCode} has been released.`}
        </p>
      </div>
    </div>
  )
}
