const http = require('http')
const { config, assertConfig } = require('./config/env')
const { connectDatabase, disconnectDatabase, supportsTransactions } = require('./db/connect')
require('./models')
const { createApp, corsOrigin } = require('./app')
const { initSocket } = require('./realtime/socket')
const { createHoldExpiryWorker } = require('./workers/holdExpiryWorker')
const mailService = require('./services/mailService')

async function main() {
  assertConfig()
  await connectDatabase(config.mongoUri)
  console.log(
    `MongoDB connected (${supportsTransactions() ? 'transactions enabled' : 'standalone: conditional updates + reconciliation'})`
  )

  if (!mailService.isConfigured()) {
    console.warn(
      'Email is not configured: student registration OTP emails cannot be sent (set SMTP_FROM and BREVO_API_KEY or SMTP_*).'
    )
  } else {
    console.log(`Email delivery: ${mailService.provider() === 'brevo' ? 'Brevo HTTPS API' : 'SMTP'}`)
  }

  const app = createApp()
  const server = http.createServer(app)
  const io = initSocket(server, { corsOrigin })

  const worker = createHoldExpiryWorker({ intervalMs: config.holdSweepIntervalMs })
  await worker.start()

  // Start server
  server.listen(config.port, () => {
    console.log(`Server running at http://localhost:${config.port}`)
  })

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`)
    worker.stop()
    io.close()
    server.close()
    await disconnectDatabase()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
