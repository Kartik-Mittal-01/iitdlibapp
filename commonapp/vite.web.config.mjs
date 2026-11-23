// Plain-web build of CommonApp: the exact same src/renderer React source the
// Electron app uses (electron.vite.config.mjs), built as an ordinary static
// site so it can be hosted anywhere and opened from a phone browser. Electron
// packaging is untouched; this is an additional build target with its own
// entry HTML (web/index.html) so the CSP/viewport can differ from the
// Electron renderer's without touching that file.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('web'),
  // So a .env / .env.local at the commonapp/ root (not inside web/) can set
  // VITE_API_BASE_URL, matching where the Electron app's app.config.json lives.
  envDir: resolve('.'),
  publicDir: resolve('src/renderer/public'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('../shared'),
      '@iitd-logo': resolve('../iitd.webp')
    },
    dedupe: ['react', 'react-dom', 'socket.io-client']
  },
  server: {
    port: 5176,
    strictPort: true,
    // Exposes the dev server on the LAN so a phone on the same Wi-Fi can reach it.
    host: true,
    fs: { allow: [resolve('.'), resolve('../shared'), resolve('../iitd.webp')] }
  },
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true
  },
  plugins: [react()]
})
