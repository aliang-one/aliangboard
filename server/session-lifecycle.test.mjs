// CSO 2026-08-30 #3 回归:平台授权必须复读 platform_users 行。
// 旧行为:会话校验只读会话行(登录时快照的 role),管理员删除/禁用/降级用户后
// 存量 token 仍全权访问至 TTL(8h)且穿越重启。本文件用活体网关(spawn 真进程)
// 断言三种处置对存量 token 均即时生效。
//
// ═══ 夹具 API(Task 7/8 共用;复制自 k8s-proxy-origin.test.mjs 的 startGateway 模式,
//     去掉假 apiserver/evil 依赖——本文件只走平台层,不接集群) ═══
//
// await startGateway(t) → { base, ptok, adminJson(method, path, body) → fetch.Response }
//   - 起真网关(spawn server/index.mjs,临时 ALIANG_DB,ADMIN_USERNAME/PASSWORD 环境变量
//     播种管理员 admin),轮询 /api/health 至就绪;管理员已登录,ptok 为其平台 token。
//   - adminJson:以管理员 token 发 JSON 请求(带 content-type 与 x-platform-token)。
//   - t.after 自动 SIGKILL 网关 + 删临时目录,调用方无需清理。
//
// await createUser(g, username, { password?, role? }) → { id, token }
//   - 用 POST /api/admin/users 建用户(12 位随机密码,role 默认 'user'),
//     再走 POST /api/auth/login 拿该用户 token。token 即「存量 token」受测对象。
//
// await login(g, username, password) → { token } — 任意用户登录(200 断言内建)。
//
// Task 7 用例建议:降级/删除后 token 不能再建管理员 —— 复用 createUser({role:'admin'})
//   + adminJson PATCH role:'user' + 该 token 打 /api/admin/* 断 403/401。
// Task 8 用例建议:重连替换旧 k8s token/logout 回收 —— 需在 startGateway 里补假
//   apiserver(可参考 server/k8s-proxy-origin.test.mjs 的 createServer 写法)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN_PW = 'x'.repeat(12)

async function startGateway(t) {
  const GW_PORT = 26100 + Math.floor(Math.random() * 3000)
  const DIR = mkdtempSync(join(tmpdir(), 'sess-life-'))
  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      ALIANG_DB: join(DIR, 'o.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: ADMIN_PW,
      ALIANG_STATIC_DIR: DIR,
      ALIANG_WORKBENCH_DIR: join(DIR, 'wb'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { gw.kill('SIGKILL'); rmSync(DIR, { recursive: true, force: true }) })

  const base = `http://127.0.0.1:${GW_PORT}`
  const deadline = Date.now() + 10000
  for (;;) {
    try { const h = await fetch(`${base}/api/health`); if (h.ok) break } catch { /* 未起 */ }
    if (Date.now() > deadline) throw new Error('gateway did not become healthy in 10s')
    await new Promise((r) => setTimeout(r, 150))
  }
  const { token: ptok } = await login({ base }, 'admin', ADMIN_PW)
  const g = { base, ptok }
  g.adminJson = (method, path, body) => fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return g
}

async function login({ base }, username, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(r.status, 200, `login(${username}) failed: ${r.status}`)
  return r.json()
}

async function createUser(g, username, { password, role } = {}) {
  const pw = password || `pw-${Math.random().toString(36).slice(2, 14)}`
  const r = await g.adminJson('POST', '/api/admin/users', { username, password: pw, role })
  assert.equal(r.status, 200, `create user ${username} failed: ${r.status}`)
  const { user } = await r.json()
  const { token } = await login(g, username, pw)
  return { id: user.id, token, password: pw }
}

test('禁用/删除用户后,存量 token 立即失效', { timeout: 60000 }, async (t) => {
  const g = await startGateway(t)
  const dave = await createUser(g, 'dave1')
  // 基线:未处置前 /api/auth/me 正常
  assert.equal((await fetch(`${g.base}/api/auth/me`, { headers: { 'x-platform-token': dave.token } })).status, 200)
  // 禁用 → 即时 401
  await g.adminJson('PATCH', `/api/admin/users/${dave.id}`, { disabled: 1 })
  assert.equal((await fetch(`${g.base}/api/auth/me`, { headers: { 'x-platform-token': dave.token } })).status, 401)
  // 重新启用后重登(密码不变)、再删除 → 即时 401
  await g.adminJson('PATCH', `/api/admin/users/${dave.id}`, { disabled: 0 })
  const d2 = await login(g, 'dave1', dave.password)
  await g.adminJson('DELETE', `/api/admin/users/${dave.id}`)
  assert.equal((await fetch(`${g.base}/api/auth/me`, { headers: { 'x-platform-token': d2.token } })).status, 401)
})

test('降级 admin→user 后,存量 token 的 admin 权限立即收回', { timeout: 60000 }, async (t) => {
  const g = await startGateway(t)
  const dave2 = await createUser(g, 'dave2', { role: 'admin' })
  // 基线:降级前是 admin,/api/admin/users 可访问
  assert.equal((await fetch(`${g.base}/api/admin/users`, { headers: { 'x-platform-token': dave2.token } })).status, 200)
  // 降级 → 同一 token 再访问 admin 端点即 403(role 以用户行为准)
  await g.adminJson('PATCH', `/api/admin/users/${dave2.id}`, { role: 'user' })
  assert.equal((await fetch(`${g.base}/api/admin/users`, { headers: { 'x-platform-token': dave2.token } })).status, 403)
  // 平台身份仍在(未禁用/删除)→ /api/auth/me 200
  assert.equal((await fetch(`${g.base}/api/auth/me`, { headers: { 'x-platform-token': dave2.token } })).status, 200)
})
