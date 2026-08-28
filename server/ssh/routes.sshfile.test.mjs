// /api/sshfile download 流错误语义单测(不走真网关):中途错误必须断连(res.destroy),
// 不得产出短于 content-length 的假 200;头部未发的错误要把 stderrSink 文案变成 4xx 响应体。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ensureSshSchema, createSshServer } from './store.mjs'
import { loadOrCreateKey } from './crypt.mjs'
import { createSshRoutes } from './routes.mjs'

const DIR = mkdtempSync(join(tmpdir(), 'sshfile-dl-'))

function mkEnv(errScript) {
  const db = new DatabaseSync(':memory:')
  ensureSshSchema(db)
  const key = loadOrCreateKey(join(DIR, `k-${Math.random().toString(36).slice(2)}.key`))
  const server = createSshServer(db, key, { name: 't1', host: '127.0.0.1', port: 22, username: 'u',
    authMethod: 'password', password: 'pw' }, 'tester')
  const released = []
  const mkSftp = () => ({
    stat: (_p, cb) => cb(null, { size: 100 }),
    createReadStream: () => {
      const rs = new EventEmitter()
      rs.destroy = () => {}
      setImmediate(() => errScript(rs))
      return rs
    },
    end: () => {},
  })
  const pool = { acquire: async () => ({ client: { sftp: cb => cb(null, mkSftp()) }, release: () => released.push(1) }) }
  const res = {
    headersSent: false, statusCode: 0, body: [], ended: false, destroyed: false,
    setHeader() {}, writeHead(s) { this.statusCode = s; this.headersSent = true },
    write(c) { this.body.push(c) }, end() { this.ended = true }, destroy() { this.destroyed = true },
  }
  const routes = createSshRoutes({
    db, cryptKey: key, sshPool: pool,
    sendJson: (r, status, body) => { r.statusCode = status; r.json = body },
    readBody: async () => ({ serverId: server.id, path: '/etc/hosts' }),
    requirePlatform: () => ({ username: 'tester' }),
    requireAdmin: () => ({ username: 'tester' }),
    getSshfileLimitBytes: () => 100 * 1024 * 1024,
  })
  const url = new URL('http://x/api/sshfile/download')
  const req = { headers: {}, method: 'POST' }
  return { routes, res, req, url, released }
}

test('sshfile download: 头部已发后流中途错误 → 连接被毁,不得 res.end() 出假 200', async () => {
  const { routes, res, req, url, released } = mkEnv(rs => {
    rs.emit('data', Buffer.alloc(100, 0x61))   // 先出一块 → writeHead(200, content-length=100)
    rs.emit('error', new Error('sftp mid-stream boom'))
    rs.emit('close')
  })
  const handled = await routes.handle(req, res, url)
  assert.equal(handled, true)
  await new Promise(r => setImmediate(r))
  assert.equal(res.destroyed, true, '连接必须中断(浏览器报网络错误)')
  assert.equal(res.ended, false, '不得正常 end 出短于 content-length 的假 200')
  assert.equal(res.headersSent, true, '头部确已发出(错误发生在传输中途,状态行已出,靠断连报错)')
  assert.equal(released.length, 1)             // 池句柄归还
})

test('sshfile download: 头部未发即错 → 4xx 且错误文案透出(stderrSink 惯例)', async () => {
  const { routes, res, req, url } = mkEnv(rs => {
    rs.emit('error', new Error('Permission denied'))
    rs.emit('close')
  })
  await routes.handle(req, res, url)
  await new Promise(r => setImmediate(r))
  assert.equal(res.statusCode, 404)
  assert.match(res.json?.message || '', /Permission denied/)
  assert.equal(res.ended, false)
})

test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ } })
