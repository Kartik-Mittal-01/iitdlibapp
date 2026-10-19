const mongoose = require('mongoose')

let transactionsSupported = null

async function connectDatabase(uri) {
  mongoose.set('strictQuery', true)
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
  transactionsSupported = await detectTransactionSupport()
  // Build declared indexes (the unique/partial indexes are part of the business rules).
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()))
  return mongoose.connection
}

async function detectTransactionSupport() {
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 })
    return Boolean(hello.setName || hello.msg === 'isdbgrid')
  } catch {
    return false
  }
}

function supportsTransactions() {
  return Boolean(transactionsSupported)
}

async function disconnectDatabase() {
  await mongoose.disconnect()
  transactionsSupported = null
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1
}

async function pingDatabase() {
  if (!isDatabaseReady()) return false
  try {
    await mongoose.connection.db.admin().command({ ping: 1 })
    return true
  } catch {
    return false
  }
}

/**
 * Runs `fn(session)` inside a MongoDB transaction when the deployment supports
 * them (replica set / sharded cluster). On a standalone server `fn(null)` runs
 * directly; callers then rely on conditional updates plus their own
 * compensation (`if (!session) { ...undo... }`) and the periodic reconciler.
 */
async function withAtomic(fn) {
  if (!supportsTransactions()) return fn(null)
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result
  } finally {
    await session.endSession()
  }
}

function opts(session, extra = {}) {
  return session ? { ...extra, session } : extra
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  supportsTransactions,
  isDatabaseReady,
  pingDatabase,
  withAtomic,
  opts,
  // Exposed for tests that exercise the non-transactional fallback.
  _setTransactionsSupported(v) {
    transactionsSupported = v
  }
}
