// Brevo HTTPS transport (mailService.createBrevoTransport) with a stubbed fetch:
// request shape, success, and error mapping. No network, no database.
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
require('./helpers') // test env (blanks real mail settings)
const { createBrevoTransport } = require('../src/services/mailService')

const KEY = 'xkeysib-test-secret-key-value'
const MESSAGE = {
  from: '"IIT Delhi Central Library" <library@example.com>',
  to: 'student@iitd.ac.in',
  subject: 'Your code',
  text: 'Your verification code is 123456',
  html: '<p>123456</p>'
}

function stubFetch(respond) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  return { calls, fetchImpl }
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('Brevo HTTPS mail transport', () => {
  test('posts the message to the Brevo API with the key in a header', async () => {
    const { calls, fetchImpl } = stubFetch(() => json(201, { messageId: '<abc@brevo>' }))
    const info = await createBrevoTransport(KEY, { fetchImpl }).sendMail(MESSAGE)

    assert.deepEqual(info, { messageId: '<abc@brevo>', rejected: [] })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers['api-key'], KEY)
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(body.sender, { name: 'IIT Delhi Central Library', email: 'library@example.com' })
    assert.deepEqual(body.to, [{ email: 'student@iitd.ac.in' }])
    assert.equal(body.subject, MESSAGE.subject)
    assert.equal(body.textContent, MESSAGE.text)
    assert.equal(body.htmlContent, MESSAGE.html)
    assert.ok(!calls[0].init.body.includes(KEY), 'key must not be in the request body')
  })

  test('accepts a bare sender address', async () => {
    const { calls, fetchImpl } = stubFetch(() => json(201, {}))
    await createBrevoTransport(KEY, { fetchImpl }).sendMail({ ...MESSAGE, from: 'library@example.com' })
    assert.deepEqual(JSON.parse(calls[0].init.body).sender, { email: 'library@example.com' })
  })

  test('an API rejection becomes an error with the Brevo code and no key', async () => {
    const { fetchImpl } = stubFetch(() => json(401, { code: 'unauthorized', message: 'Key not found' }))
    await assert.rejects(createBrevoTransport(KEY, { fetchImpl }).sendMail(MESSAGE), (err) => {
      assert.equal(err.code, 'unauthorized')
      assert.match(err.message, /HTTP 401: Key not found/)
      assert.ok(!err.message.includes(KEY))
      return true
    })
  })

  test('a network failure or timeout becomes ECONNECTION / ETIMEDOUT', async () => {
    const down = stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    await assert.rejects(createBrevoTransport(KEY, { fetchImpl: down.fetchImpl }).sendMail(MESSAGE), {
      code: 'ECONNECTION'
    })

    const slow = stubFetch(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    await assert.rejects(createBrevoTransport(KEY, { fetchImpl: slow.fetchImpl }).sendMail(MESSAGE), {
      code: 'ETIMEDOUT'
    })
  })
})
