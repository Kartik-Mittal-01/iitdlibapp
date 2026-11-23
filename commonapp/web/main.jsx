// Web entry point. Vite's root for the web build is this folder (web/), so the
// dev server cannot serve ../src by URL. Import the Electron renderer's real
// entry through the @renderer alias instead (resolved by file path and allowed
// by server.fs.allow in vite.web.config.mjs).
import '@renderer/main.jsx'
