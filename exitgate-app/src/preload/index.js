import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  // { apiBaseUrl, terminalConfigured, terminalCode }
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  // Short-lived terminal token from the server; the device key never reaches the renderer.
  getTerminalToken: (force = false) => ipcRenderer.invoke('gate:get-token', force)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
