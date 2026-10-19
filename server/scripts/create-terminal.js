#!/usr/bin/env node
// Registers a gate terminal (or rotates its key) and prints the key ONCE.
//
//   npm run create-terminal -- --code ENTRY-1 --type entry --name "Main entrance"
//   npm run create-terminal -- --code ENTRY-1 --rotate
//
// Put the printed key in the ESP32's secure configuration and in the gate
// kiosk's GATE_TERMINAL_KEY. Only its SHA-256 hash is stored in MongoDB.
const { parseArgs, run } = require('./_cli')
const { GateTerminal } = require('../src/models')
const adminService = require('../src/services/adminService')

const args = parseArgs()

run(async () => {
  const code = String(args.code || '')
    .trim()
    .toUpperCase()
  if (!code) throw new Error('Usage: --code <CODE> (--type entry|exit --name "<name>" | --rotate)')

  let result
  if (args.rotate) {
    const t = await GateTerminal.findOne({ terminalCode: code })
    if (!t) throw new Error(`No terminal ${code}.`)
    result = await adminService.rotateTerminalKey(t._id, null)
  } else {
    if (!['entry', 'exit'].includes(args.type)) throw new Error('--type must be entry or exit')
    result = await adminService.createTerminal(
      { terminalCode: code, gateType: args.type, name: String(args.name || code) },
      null
    )
  }
  console.log(`Terminal ${result.terminal.terminalCode} (${result.terminal.gateType})`)
  console.log(`GATE_TERMINAL_CODE=${result.terminal.terminalCode}`)
  console.log(`GATE_TERMINAL_KEY=${result.terminalKey}`)
  console.log('Store this key securely now; it cannot be shown again.')
})
