import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const DEFAULT_API_BASE_URL = 'https://iitd-library-backend.onrender.com'
const REFRESH_MARGIN_MS = 5 * 60 * 1000

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Gate configuration is read at runtime (never bundled into the renderer):
 *   1. environment: API_BASE_URL, GATE_TERMINAL_CODE, GATE_TERMINAL_KEY
 *   2. <userData>/gate-config.json  { apiBaseUrl, terminalCode, terminalKey }
 *   3. in development only: ./gate.config.json (gitignored)
 * The terminal key stays in the main process; the renderer only receives a
 * short-lived terminal token issued by the server.
 */
export function loadGateConfig() {
  const file = {
    ...(is.dev ? readJson(join(process.cwd(), 'gate.config.json')) : {}),
    ...readJson(join(app.getPath('userData'), 'gate-config.json'))
  }
  return {
    apiBaseUrl: String(process.env.API_BASE_URL || file.apiBaseUrl || DEFAULT_API_BASE_URL).replace(
      /\/+$/,
      ''
    ),
    terminalCode: String(process.env.GATE_TERMINAL_CODE || file.terminalCode || ''),
    terminalKey: String(process.env.GATE_TERMINAL_KEY || file.terminalKey || '')
  }
}

export function registerGateIpc(ipcMain, config) {
  let cached = null

  ipcMain.handle('app:get-config', () => ({
    apiBaseUrl: config.apiBaseUrl,
    terminalConfigured: Boolean(config.terminalCode && config.terminalKey),
    terminalCode: config.terminalCode || null
  }))

  ipcMain.handle('gate:get-token', async (_event, force) => {
    if (!config.terminalCode || !config.terminalKey) {
      return {
        ok: false,
        error: { code: 'TERMINAL_NOT_CONFIGURED', message: 'This gate terminal is not configured.' }
      }
    }
    if (!force && cached && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return { ok: true, ...cached.data }
    }
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/gate/terminal/token`, {
        method: 'POST',
        headers: {
          'X-Terminal-Code': config.terminalCode,
          'X-Terminal-Key': config.terminalKey
        }
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        cached = null
        return { ok: false, error: body?.error || { code: 'SERVICE_UNAVAILABLE' } }
      }
      cached = { data: body.data, expiresAtMs: new Date(body.data.expiresAt).getTime() }
      return { ok: true, ...body.data }
    } catch {
      return {
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Cannot reach the library server.' }
      }
    }
  })
}
