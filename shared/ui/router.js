import { useSyncExternalStore } from 'react'

// Minimal hash router: "#/gate" -> "/gate". Hash routes work for both the dev
// server and the packaged file:// build.
function subscribe(callback) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

function currentRoute() {
  return window.location.hash.replace(/^#/, '') || '/'
}

export function useRoute() {
  return useSyncExternalStore(subscribe, currentRoute)
}

export function navigate(route) {
  window.location.hash = route
}
