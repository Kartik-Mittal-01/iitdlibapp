const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const { config } = require('./config/env')
const { isDatabaseReady, pingDatabase, supportsTransactions } = require('./db/connect')
const { apiLimiter } = require('./middleware/rateLimit')
const { notFound, errorHandler } = require('./middleware/errorHandler')

// Origins allowed to call the API from a browser context. Requests without an
// Origin header (ESP32, curl) are not subject to CORS. Auth uses bearer
// tokens, not cookies, so CORS is defence in depth rather than the boundary.
function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true)
  // Packaged Electron renderers load from file://: fetch sends "null", WebSocket sends "file://".
  if ((origin === 'null' || origin === 'file://') && config.corsAllowNullOrigin) {
    return callback(null, true)
  }
  if (config.corsOrigins.includes(origin)) return callback(null, true)
  return callback(new Error('Not allowed by CORS'))
}

function createApp() {
  const app = express()
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)
  app.disable('x-powered-by')

  app.use(helmet())
  app.use(cors({ origin: corsOrigin }))
  app.use(express.json({ limit: '32kb' }))

  // Home route
  app.get('/', (req, res) => {
    res.json({
      message: 'Welcome to the IITD Library API!'
    })
  })

  // Health-check route (process is up)
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'OK',
      message: 'Backend is running successfully'
    })
  })

  // Readiness: dependencies are reachable and the API can serve requests.
  app.get('/api/ready', async (req, res) => {
    const mongo = await pingDatabase()
    res.status(mongo ? 200 : 503).json({
      success: mongo,
      data: {
        ready: mongo,
        mongodb: mongo ? 'up' : isDatabaseReady() ? 'unresponsive' : 'down',
        transactions: mongo ? supportsTransactions() : null
      }
    })
  })

  app.use('/api', apiLimiter)
  app.use('/api/auth', require('./routes/auth.routes'))
  app.use('/api/admin', require('./routes/admin.routes'))
  app.use('/api/gate', require('./routes/gate.routes'))
  app.use('/api/library', require('./routes/library.routes'))

  app.use(notFound)
  app.use(errorHandler)
  return app
}

module.exports = { createApp, corsOrigin }
