// Shared definitions used by the server and every frontend.
//
// The server is the only authority on these states. Frontends must render the
// state the server sends; they must never derive a seat state from a colour or
// from a local countdown timer.
//
// Relationship between session state, seat state and map colour:
//
//   LibrarySession.status | Seat.status | Map colour | Meaning
//   ----------------------+-------------+------------+-------------------------------------------
//   (no open session)     | available   | green      | Free; may be allocated at an entry gate.
//   inside                | occupied    | red        | Student admitted and currently inside.
//   hold                  | reserved    | yellow     | Student left via "15-minute hold"; seat kept
//                         |             |            | until session.holdUntil (= seat.reservedUntil).
//   completed             | available   | green      | Visit ended (immediate exit, or hold expired).
//
// Invariants enforced by the server:
//   * A seat is non-available  <=>  seat.sessionId points to an open session
//     (status inside or hold) whose seatId is that seat.
//   * A student has at most one open session (unique partial index).
//   * A hold that reaches holdUntil is finalised by the server (background
//     sweep + lazy check before every entry/allocation/map read), never by a
//     frontend timer.

export const SEAT_STATUS = Object.freeze({
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  RESERVED: 'reserved'
})

export const SESSION_STATUS = Object.freeze({
  INSIDE: 'inside',
  HOLD: 'hold',
  COMPLETED: 'completed'
})

export const SEAT_STATUS_FOR_SESSION = Object.freeze({
  [SESSION_STATUS.INSIDE]: SEAT_STATUS.OCCUPIED,
  [SESSION_STATUS.HOLD]: SEAT_STATUS.RESERVED,
  [SESSION_STATUS.COMPLETED]: SEAT_STATUS.AVAILABLE
})

export const MAP_LEGEND = Object.freeze({
  [SEAT_STATUS.AVAILABLE]: {
    color: 'green',
    hex: '#22c55e',
    label: 'Available'
  },
  [SEAT_STATUS.OCCUPIED]: { color: 'red', hex: '#ef4444', label: 'Occupied' },
  [SEAT_STATUS.RESERVED]: {
    color: 'yellow',
    hex: '#eab308',
    label: 'Reserved (on hold)'
  }
})

export function seatColor(status) {
  return (MAP_LEGEND[status] || MAP_LEGEND[SEAT_STATUS.OCCUPIED]).hex
}

export const HOLD_DURATION_MS = 15 * 60 * 1000

export const GATE_TYPES = Object.freeze({ ENTRY: 'entry', EXIT: 'exit' })

// What the gate UI should do after a scan has been accepted by the server.
export const GATE_NEXT_ACTION = Object.freeze({
  SELECT_SEAT: 'select_seat', // entry gate: new visit, student picks a table/seat
  RESUME_HOLD: 'resume_hold', // entry gate: valid hold, confirm to resume same seat
  CHOOSE_EXIT: 'choose_exit' // exit gate: choose immediate exit or 15-minute hold
})

export const EXIT_MODES = Object.freeze({ EXIT: 'exit', HOLD: 'hold' })

export const SOCKET_EVENTS = Object.freeze({
  // client -> server
  GATE_SUBSCRIBE: 'gate:subscribe',
  MAP_SUBSCRIBE: 'map:subscribe',
  ADMIN_SUBSCRIBE: 'admin:subscribe',
  // server -> client
  GATE_RESULT: 'gate:result',
  MAP_UPDATED: 'map:updated',
  OCCUPANCY_UPDATED: 'occupancy:updated',
  SESSION_UPDATED: 'session:updated',
  ADMIN_LOG: 'admin:log'
})

// Error codes returned by the API as { success: false, error: { code, message } }.
// Messages here are the user-facing wording for gate screens.
export const ERROR_MESSAGES = Object.freeze({
  VALIDATION_ERROR: 'Some of the submitted information is invalid.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: 'You are not allowed to do that.',
  NOT_FOUND: 'Not found.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  DUPLICATE_STUDENT: 'A student with this entry number or email is already registered.',
  EMAIL_NOT_ALLOWED: 'Please use your IIT Delhi email address.',
  EMAIL_NOT_VERIFIED:
    'Please verify your email address with the code we sent before creating your account.',
  EMAIL_NOT_CONFIGURED:
    'Email verification is not set up on the server yet. Please contact the library.',
  EMAIL_DELIVERY_FAILED: 'We could not send the verification email. Please try again shortly.',
  OTP_COOLDOWN: 'Please wait before requesting another code.',
  OTP_TOO_MANY_REQUESTS: 'Too many codes requested for this email. Please try again later.',
  OTP_INVALID: 'That code is incorrect.',
  OTP_EXPIRED: 'That code has expired. Please request a new one.',
  OTP_ATTEMPTS_EXCEEDED: 'Too many incorrect attempts. Please request a new code.',
  OTP_NOT_FOUND: 'No active code for this email. Please request a new one.',
  UNKNOWN_CARD: 'This card is not registered. Please contact the library desk.',
  CARD_REVOKED: 'This card has been deactivated. Please contact the library desk.',
  STUDENT_INACTIVE: 'Your library access is inactive. Please contact the library desk.',
  DUPLICATE_ENTRY: 'You are already checked in.',
  NOT_INSIDE: 'You are not checked in.',
  ALREADY_ON_HOLD: 'You have already left with a seat hold.',
  DUPLICATE_EXIT: 'This exit has already been recorded.',
  SEAT_UNAVAILABLE: 'That seat was just taken. Please choose another.',
  TABLE_FULL: 'That table is full. Please choose another.',
  LIBRARY_FULL: 'The library is full right now.',
  TABLE_NOT_FOUND: 'That table is not available.',
  SCAN_EXPIRED: 'This scan has expired. Please tap your card again.',
  SCAN_IN_PROGRESS: 'This scan is already being processed.',
  SCAN_WRONG_GATE: 'This scan belongs to a different gate.',
  STATE_CHANGED: 'Your visit changed while this was processing. Please tap your card again.',
  TERMINAL_UNAUTHORIZED: 'This gate terminal is not authorised.',
  SERVICE_UNAVAILABLE: 'The library service is temporarily unavailable.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.'
})

export function errorMessage(code, fallback) {
  return ERROR_MESSAGES[code] || fallback || ERROR_MESSAGES.INTERNAL_ERROR
}

// Logical size of the library floor plan; table/seat coordinates use this space.
// Matches the reference layout grid in libraryLayout.mjs (22 x 100, 29 x 40).
export const MAP_CANVAS = Object.freeze({ width: 2200, height: 1160 })
