// /api/sshfile 三件套(mkdir/delete/rename)路由行为测试(不走真网关):DI 假池注入
// client.exec,覆盖 校验拒绝(名字/根,不达 exec)/已存在 409/成功 200/超时 null→502/审计行。
// exec 通道与上传预检同源(sshExecCommand);SFTP 无递归删除故 delete 走 rm -rf --。
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

const DIR = mkdtempSync(join(tmpdir(), 'sshfile-ops-'))

// mkEnv({ path, name }, execResult | null):
//   body 在真实 server.id 落定后构造(readBody 返回它);execResult=null 且 execTimeout
//   才走超时分支——单独参数 execTimeout 表达「假流永不 close」。
function mkEnv(fields = {}, execResult = { code: 0 }, execTimeout = false) {
  const db = new DatabaseSync(':memory:')
  ensureSshSchema(db)
  const key = loadOrCreateKey(join(DIR, `k-${Math.random().toString(36).slice(2)}.key`))
  const server = createSshServer(db, key, { name: 't1', host: '127.0.0.1', port: 22, username: 'u',
    authMethod: 'password', password: 'pw' }, 'tester')
  const body = { serverId: server.id, path: fields.path ?? '/', name: fields.name ?? '' }
  const execCalls = []
  const mkStream = () => {
    const s = new EventEmitter()
    s.stderr = new EventEmitter()
    s.destroy = () => {}
    if (!execTimeout) setImmediate(() => {
      if (execResult?.stdout) s.emit('data', Buffer.from(execResult.stdout))
      if (execResult?.stderr) s.stderr.emit('data', Buffer.from(execResult.stderr))
      s.emit('close', execResult?.code ?? 0)
    })
    return s
  }
  const pool = { acquire: async () => ({
    client: { exec: (cmd, cb) => { execCalls.push(cmd); cb(null, mkStream()) } },
    release: () => {},
  }) }
  const audits = []
  const res = {
    headersSent: false, statusCode: 0,
    setHeader() {}, writeHead(s) { this.statusCode = s; this.headersSent = true },
    write() {}, end() {},
  }
  const routes = createSshRoutes({
    db, cryptKey: key, sshPool: pool,
    sendJson: (r, status, body2) => { r.statusCode = status; r.json = body2 },
    readBody: async () => body,
    requirePlatform: () => ({ username: 'tester' }),
    requireAdmin: () => ({ username: 'tester' }),
    getSshfileLimitBytes: () => 100 * 1024 * 1024,
    sshFileOpTimeoutMs: 200,   // 测试不等真 60s 超时
    writeAudit: (_db, entry) => audits.push(entry),
  })
  const req = { headers: {}, method: 'POST' }
  return { routes, res, req, audits, execCalls }
}

async function runOp(env, action) {
  const url = new URL(`http://x/api/sshfile/${action}`)
  await env.routes.handle(env.req, env.res, url)
  return env.res
}

test('mkdir:成功 → 200 + shellQuote 命令 + ok 审计 + 归还池', async () => {
  const env = mkEnv({ path: '/data', name: 'logs' })
  const res = await runOp(env, 'mkdir')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.path, '/data/logs')
  assert.deepEqual(env.execCalls, [`mkdir '/data/logs'`])
  assert.equal(env.audits.filter(a => a.result === 'ok' && a.tool === 'ssh_sftp').length, 1)
})

test('mkdir:已存在 → 409 + File exists 透出 + denied 审计', async () => {
  const env = mkEnv({ path: '/data', name: 'logs' }, { code: 1, stderr: "mkdir: cannot create directory '/data/logs': File exists" })
  const res = await runOp(env, 'mkdir')
  assert.equal(res.statusCode, 409)
  assert.match(res.json.message, /File exists/)
  assert.equal(env.audits.filter(a => a.result === 'denied').length, 1)
})

test('mkdir:名字含 / → 400(防路径穿越,不达 exec)', async () => {
  const env = mkEnv({ path: '/data', name: 'a/b' })
  const res = await runOp(env, 'mkdir')
  assert.equal(res.statusCode, 400)
  assert.equal(env.execCalls.length, 0)
})

test('delete:根路径 → 400 拒绝(服务端硬底线,不达 exec)', async () => {
  const env = mkEnv({ path: '/' })
  const res = await runOp(env, 'delete')
  assert.equal(res.statusCode, 400)
  assert.equal(env.execCalls.length, 0)
  assert.equal(env.audits.filter(a => a.result === 'denied').length, 1)
})

test('delete:成功 → rm -rf -- 命令 + 200', async () => {
  const env = mkEnv({ path: '/data/old' })
  const res = await runOp(env, 'delete')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(env.execCalls, [`rm -rf -- '/data/old'`])
})

test('rename:成功 → mv 双路径 + 200 + 新路径回传', async () => {
  const env = mkEnv({ path: '/data/a.txt', name: 'b.txt' })
  const res = await runOp(env, 'rename')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.path, '/data/b.txt')
  assert.deepEqual(env.execCalls, [`mv -- '/data/a.txt' '/data/b.txt'`])
})

test('rename:名字为 .. → 400', async () => {
  const env = mkEnv({ path: '/data/a.txt', name: '..' })
  const res = await runOp(env, 'rename')
  assert.equal(res.statusCode, 400)
  assert.equal(env.execCalls.length, 0)
})

test('exec 超时(流不 close → null)→ 502 + denied 审计', async () => {
  const env = mkEnv({ path: '/data', name: 'slow' }, null, true)
  const res = await runOp(env, 'mkdir')
  assert.equal(res.statusCode, 502)
  assert.equal(env.audits.filter(a => a.result === 'denied').length, 1)
})

test('路径含单引号 → shellQuote 逃逸,命令仍安全', async () => {
  const env = mkEnv({ path: `/d/it's`, })
  const res = await runOp(env, 'delete')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(env.execCalls, [`rm -rf -- '/d/it'\\''s'`])
})
