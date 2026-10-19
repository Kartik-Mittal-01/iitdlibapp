const visitService = require('../services/visitService')
const publisher = require('../realtime/publisher')
const { isDatabaseReady } = require('../db/connect')

const RECONCILE_EVERY_N_TICKS = 4

/**
 * Releases seats whose 15-minute hold has expired. State lives in MongoDB
 * (session.holdUntil), so nothing is lost on restart: the first sweep runs
 * immediately on start-up and finalises every hold that expired while the
 * server was down. Entry/scan/map requests also expire due holds lazily, so a
 * late sweep can never block a seat.
 */
function createHoldExpiryWorker({ intervalMs }) {
  let timer = null
  let running = false
  let ticks = 0

  async function tick() {
    if (running || !isDatabaseReady()) return
    running = true
    const changes = visitService.newChanges()
    try {
      const expired = await visitService.expireDueHolds({}, changes)
      if (ticks % RECONCILE_EVERY_N_TICKS === 0) await visitService.reconcile({}, changes)
      if (expired) console.log(`[holds] released ${expired} expired hold(s)`)
    } catch (err) {
      console.error('[holds] sweep failed:', err.message)
    } finally {
      ticks += 1
      running = false
      await publisher.publish(changes)
    }
  }

  return {
    async start() {
      await tick()
      timer = setInterval(tick, intervalMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick
  }
}

module.exports = { createHoldExpiryWorker }
