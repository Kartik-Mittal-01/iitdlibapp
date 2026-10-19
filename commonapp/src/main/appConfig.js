import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const DEFAULT_API_BASE_URL = 'https://iitd-library-backend.onrender.com'

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Runtime configuration (never bundled into the renderer):
 *   1. environment: API_BASE_URL
 *   2. <userData>/app-config.json  { apiBaseUrl }
 *   3. in development only: ./app.config.json (gitignored)
 * This app has no gate terminal credentials; students and staff sign in.
 */
export function loadAppConfig() {
  const file = {
    ...(is.dev ? readJson(join(process.cwd(), 'app.config.json')) : {}),
    ...readJson(join(app.getPath('userData'), 'app-config.json'))
  }
  return {
    apiBaseUrl: String(process.env.API_BASE_URL || file.apiBaseUrl || DEFAULT_API_BASE_URL).replace(
      /\/+$/,
      ''
    )
  }
}

export function registerAppIpc(ipcMain, config) {
  ipcMain.handle('app:get-config', () => ({ apiBaseUrl: config.apiBaseUrl }))
}
