// Small helpers shared by the maintenance scripts.
const readline = require('readline')
const { config, assertConfig } = require('../src/config/env')
const { connectDatabase, disconnectDatabase } = require('../src/db/connect')
require('../src/models')

function parseArgs(argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.slice(2).split('=')
    if (v !== undefined) args[k] = v
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[(i += 1)]
    else args[k] = true
  }
  return args
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('No TTY available for a password prompt.'))
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    })
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function run(fn) {
  try {
    assertConfig()
  } catch (err) {
    console.error(`${err.message}\n(see server/.env.example)`)
    process.exit(1)
  }
  try {
    await connectDatabase(config.mongoUri)
    await fn()
    await disconnectDatabase()
  } catch (err) {
    console.error(`Error: ${err.message}`)
    await disconnectDatabase().catch(() => {})
    process.exit(1)
  }
}

module.exports = { parseArgs, promptHidden, run }
