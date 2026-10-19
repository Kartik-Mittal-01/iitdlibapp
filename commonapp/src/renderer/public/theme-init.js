// Applies the saved (or OS-preferred) theme before the app renders, so the
// window never flashes the wrong colours. Loaded from index.html (CSP: 'self').
;(function () {
  var theme = 'light'
  try {
    var saved = window.localStorage.getItem('iitdlib.theme')
    if (saved === 'light' || saved === 'dark') theme = saved
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark'
  } catch {
    // Storage unavailable: fall back to light.
  }
  var root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.background = theme === 'dark' ? '#0b0b0c' : '#fafafa'
})()
