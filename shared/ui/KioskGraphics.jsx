// Kiosk illustrations: the idle contactless antenna and the success tick.

export function Antenna() {
  return (
    <svg
      className="antenna"
      viewBox="0 0 200 200"
      role="img"
      aria-label="Card reader waiting for a card"
    >
      <g className="antenna-waves" fill="none" strokeLinecap="round">
        <path className="wave wave-1" d="M70 72 a42 42 0 0 0 0 56" />
        <path className="wave wave-1" d="M130 72 a42 42 0 0 1 0 56" />
        <path className="wave wave-2" d="M55 55 a66 66 0 0 0 0 90" />
        <path className="wave wave-2" d="M145 55 a66 66 0 0 1 0 90" />
        <path className="wave wave-3" d="M40 38 a90 90 0 0 0 0 124" />
        <path className="wave wave-3" d="M160 38 a90 90 0 0 1 0 124" />
      </g>
      <g className="antenna-mast">
        <circle cx="100" cy="100" r="9" />
        <line x1="100" y1="109" x2="100" y2="168" />
        <line x1="78" y1="170" x2="122" y2="170" />
      </g>
    </svg>
  )
}

export function SuccessTick() {
  return (
    <svg className="tick" viewBox="0 0 96 96" role="img" aria-label="Success">
      <circle className="tick-circle" cx="48" cy="48" r="44" />
      <path className="tick-check" d="M29 50 l13 13 l26 -28" />
    </svg>
  )
}

export function NoticeMark() {
  return (
    <svg className="notice" viewBox="0 0 96 96" aria-hidden="true">
      <circle cx="48" cy="48" r="44" />
      <line x1="48" y1="26" x2="48" y2="56" />
      <circle className="notice-dot" cx="48" cy="69" r="3.5" />
    </svg>
  )
}
