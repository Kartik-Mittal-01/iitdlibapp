import { io } from 'socket.io-client'

/**
 * Creates an authenticated Socket.IO client. The token is fetched on every
 * (re)connect, so a refreshed token is picked up automatically. Created with
 * autoConnect off: callers connect in an effect and disconnect on cleanup.
 */
export function connectSocket(baseUrl, getToken) {
  return io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnectionDelayMax: 5000,
    auth: (cb) => {
      Promise.resolve(getToken())
        .then((token) => cb({ token }))
        .catch(() => cb({}))
    }
  })
}
