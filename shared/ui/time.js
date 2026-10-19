import { useEffect, useState } from 'react'

// Display helpers only. Expiry decisions are always made by the server; the
// local clock is corrected by the server's time so countdowns line up.

/**
 * Server clock minus local clock, measured once when a response arrives:
 * `serverTime` from the response, `receivedAt` = Date.now() at that moment.
 * (Recomputing it at render time would cancel out the passage of time.)
 */
export function serverOffsetMs(serverTime, receivedAt) {
  return serverTime && receivedAt ? new Date(serverTime).getTime() - receivedAt : 0
}

export function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatDateTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** Seconds as MM:SS, e.g. 899 -> "14:59", 45 -> "00:45". */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  return `${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Whole seconds until `target` (a server timestamp), on the server's clock:
 *   max(0, ceil((target - (Date.now() + offsetMs)) / 1000))
 * Always derived from the timestamp, never decremented, so it is correct after
 * a reload and catches up immediately when the window becomes active again.
 */
export function useSecondsUntil(target, offsetMs = 0) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!target) return undefined
    const tick = () => setNow(Date.now())
    // Sub-second polling so the display changes right on each second boundary.
    const id = setInterval(tick, 250)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [target])
  if (!target) return null
  return Math.max(0, Math.ceil((new Date(target).getTime() - (now + offsetMs)) / 1000))
}

/**
 * Seconds left until `deadline` (ms timestamp), for a visible countdown. The
 * caller owns the actual expiry timer; this only drives the display.
 */
export function useCountdown(deadline, totalSeconds) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!deadline) return undefined
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [deadline])
  if (!deadline) return null
  return Math.min(totalSeconds, Math.max(0, Math.ceil((deadline - now) / 1000)))
}
