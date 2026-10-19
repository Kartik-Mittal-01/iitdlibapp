import { useState } from 'react'
import { useCountdown } from './time'

/** Visible countdown (seconds + draining bar). Display only; the caller owns expiry. */
export function Countdown({ deadline, seconds, paused = false }) {
  const left = useCountdown(paused ? null : deadline, seconds)
  return (
    <div
      className="countdown"
      role="timer"
      aria-live="off"
      aria-label={`${left ?? 0} seconds left`}
    >
      <span className="countdown-bar" aria-hidden="true">
        {!paused && <span key={deadline} style={{ animationDuration: `${seconds}s` }} />}
      </span>
      <span className="countdown-num">{paused ? '…' : left}</span>
      <span className="muted">s</span>
    </div>
  )
}

/** Small terminal/connection line in the kiosk corner. */
export function KioskStatus({ config, terminal, connected }) {
  return (
    <div className="kiosk-status">
      <span className={`dot${connected ? ' is-on' : ''}`} />
      <span>
        {terminal?.terminalCode || config?.terminalCode || 'Terminal'} ·{' '}
        {connected ? 'Online' : 'Offline'}
      </span>
    </div>
  )
}

/**
 * Development-only stand-in for the ESP32 reader: submits the same
 * authenticated POST /api/gate/scan as this terminal. Collapsed by default.
 */
export function DevScan({ api, onStart, onScan, onError }) {
  const [open, setOpen] = useState(false)
  const [cardUid, setCardUid] = useState('')
  async function send(e) {
    e.preventDefault()
    onStart?.()
    try {
      onScan(await api.post('/api/gate/scan', { cardUid }))
    } catch (err) {
      if (err.details?.stage === 'scan') onScan(err.details)
      else onError(err.message)
    }
    setCardUid('')
  }
  return (
    <div className="kiosk-tools">
      {open ? (
        <form onSubmit={send}>
          <input
            autoFocus
            value={cardUid}
            onChange={(e) => setCardUid(e.target.value)}
            placeholder="Card UID (dev)"
            aria-label="Card UID"
          />
          <button className="btn btn-sm" type="submit" disabled={!cardUid}>
            Scan
          </button>
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </form>
      ) : (
        <button className="btn btn-sm btn-ghost muted" onClick={() => setOpen(true)}>
          Manual scan
        </button>
      )}
    </div>
  )
}

/** Gate configuration / authorisation problem, shown instead of the idle prompt. */
export function terminalProblem(config, authError) {
  if (config && !config.terminalConfigured) {
    return 'This gate terminal is not configured. Set GATE_TERMINAL_CODE and GATE_TERMINAL_KEY.'
  }
  if (authError?.code === 'TERMINAL_UNAUTHORIZED') {
    return 'This gate terminal is not authorised. Check its terminal code and key.'
  }
  if (authError) return authError.message || 'Cannot reach the library server.'
  return null
}
