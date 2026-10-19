#!/usr/bin/env node
// Bootstraps a staff account. There is deliberately no public staff signup.
//
//   npm run create-admin -- --email librarian@iitd.ac.in --name "Head Librarian"
//   npm run create-admin -- --email desk@iitd.ac.in --name "Desk" --role staff
//
// The password is prompted for (not echoed) or read from ADMIN_BOOTSTRAP_PASSWORD
// for non-interactive provisioning. It is never accepted as a CLI argument, so it
// does not end up in shell history or process listings.
//
// Creating an *admin* when one already exists requires --allow-additional-admin,
// so the script cannot be used to quietly add a second admin by mistake.
const { parseArgs, promptHidden, run } = require('./_cli')
const { Staff } = require('../src/models')
const authService = require('../src/services/authService')
const audit = require('../src/services/auditService')

const args = parseArgs()

run(async () => {
  const email = String(args.email || '')
    .trim()
    .toLowerCase()
  const name = String(args.name || '').trim()
  const role = args.role === 'staff' ? 'staff' : 'admin'
  if (!email || !name) {
    throw new Error(
      'Usage: npm run create-admin -- --email <email> --name "<name>" [--role admin|staff]'
    )
  }
  if (
    role === 'admin' &&
    (await Staff.exists({ role: 'admin' })) &&
    !args['allow-additional-admin']
  ) {
    throw new Error('An admin already exists. Pass --allow-additional-admin to create another.')
  }
  if (await Staff.exists({ email })) throw new Error(`A staff account for ${email} already exists.`)

  let password = process.env.ADMIN_BOOTSTRAP_PASSWORD
  if (!password) {
    password = await promptHidden('Password (min 12 chars): ')
    const confirm = await promptHidden('Confirm password: ')
    if (password !== confirm) throw new Error('Passwords do not match.')
  }
  if (password.length < 12) throw new Error('Password must be at least 12 characters.')
  if (Buffer.byteLength(password) > 72) throw new Error('Password must be at most 72 bytes.')

  const staff = await authService.createStaff({ name, email, password, role })
  await audit.record({
    actor: null,
    action: 'admin.staff_bootstrapped',
    details: { staffId: staff._id, role }
  })
  console.log(`Created ${role} account ${email} (${staff._id}).`)
})
