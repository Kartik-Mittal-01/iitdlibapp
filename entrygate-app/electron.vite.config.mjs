import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // State/colour/event definitions shared with the server (iitdlibapp/shared)
        '@shared': resolve('../shared')
      },
      // Files in ../shared resolve these from this app's node_modules.
      dedupe: ['react', 'react-dom', 'socket.io-client']
    },
    server: {
      port: 5173,
      strictPort: true,
      fs: { allow: [resolve('.'), resolve('../shared')] }
    },
    plugins: [react()]
  }
})
