#!/usr/bin/env node
// Links an RFID card UID to a registered student (staff can also do this in the admin UI).
//
//   npm run register-card -- --entry 2021CS10123 --uid 04A31B22 [--replace]
const { parseArgs, run } = require('./_cli')
const adminService = require('../src/services/adminService')

const args = parseArgs()

run(async () => {
  if (!args.entry || !args.uid)
    throw new Error('Usage: --entry <ENTRY_NUMBER> --uid <HEX_UID> [--replace]')
  const card = await adminService.registerCard(
    {
      entryNumber: String(args.entry),
      cardUid: String(args.uid),
      replaceExisting: Boolean(args.replace)
    },
    null
  )
  console.log(`Registered card …${card.cardUidHint} for ${String(args.entry).toUpperCase()}.`)
})
