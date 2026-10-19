import { useState } from 'react'

const STORAGE_KEY = 'iitdlib.theme'

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/** Light/dark switch for CommonApp. public/theme-init.js applies it before first paint. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme)
  const dark = theme === 'dark'

  function toggle() {
    const next = dark ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    document.documentElement.style.background = ''
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not persisted if storage is unavailable; the switch still works.
    }
    setTheme(next)
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={dark}
      aria-label="Dark theme"
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggle}
    >
      {dark ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
      <span>{dark ? 'Dark' : 'Light'}</span>
    </button>
  )
}
