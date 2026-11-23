// Browser origins: a deployed web frontend (e.g. CommonApp on Vercel) can call the
// API only when its exact origin is listed in CORS_ORIGINS. An unlisted origin is
// refused without CORS headers, which browsers report as a failed fetch ("Cannot
// reach the library server"). No database needed: preflight and /api/health only.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
require('./helpers') // test environment
const { config } = require('../src/config/env')
const { createApp } = require('../src/app')

const WEB_ORIGIN = 'https://iitd-library-web.example.vercel.app'

function preflight(app, origin) {
  return request(app)
    .options('/api/auth/login')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type')
}

describe('CORS for deployed web frontends', () => {
  let saved
  beforeEach(() => {
    saved = config.corsOrigins
  })
  afterEach(() => {
    config.corsOrigins = saved
  })

  test('an unlisted HTTPS origin is refused with no CORS headers', async () => {
    config.corsOrigins = ['http://localhost:5176']
    const res = await preflight(createApp(), WEB_ORIGIN)
    assert.equal(res.status, 403)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
    assert.equal(res.body.error.code, 'FORBIDDEN')
  })

  test('the same origin is allowed once listed in CORS_ORIGINS', async () => {
    config.corsOrigins = ['http://localhost:5176', WEB_ORIGIN]
    const app = createApp()

    const pre = await preflight(app, WEB_ORIGIN)
    assert.equal(pre.status, 204)
    assert.equal(pre.headers['access-control-allow-origin'], WEB_ORIGIN)
    assert.match(pre.headers['access-control-allow-methods'], /POST/)

    const res = await request(app).get('/api/health').set('Origin', WEB_ORIGIN)
    assert.equal(res.status, 200)
    assert.equal(res.headers['access-control-allow-origin'], WEB_ORIGIN)
  })

  test('origins must match exactly (no trailing slash, scheme matters)', async () => {
    config.corsOrigins = [`${WEB_ORIGIN}/`]
    assert.equal((await preflight(createApp(), WEB_ORIGIN)).status, 403)
    config.corsOrigins = [WEB_ORIGIN.replace('https:', 'http:')]
    assert.equal((await preflight(createApp(), WEB_ORIGIN)).status, 403)
  })

  test('packaged Electron (Origin: null) keeps working', async () => {
    config.corsOrigins = []
    const res = await preflight(createApp(), 'null')
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'null')
  })
})
