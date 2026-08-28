// 本地 sshd 联调: docker run -d --name ab-sshd -p 2222:22 -e PASSWORD_ACCESS=true -e USER_PASSWORD=pass123 -e USER_NAME=ops linuxserver/openssh-server:latest
// SSH REST 路由集成测试:spawn 真网关(模式同 wb-approval-roundtrip.test.mjs)。
// 覆盖:CRUD + 脱敏(明文 pw 不得出现在任何响应)+ 校验 400 + 试连结构化错误。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 47000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'ssh-routes-'))

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'ssh.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

test('SSH CRUD + 脱敏 + 试连结构化错误', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 创建(password 认证 + 暴露 AI + readonly 策略),host 指向必拒绝端口 → 试连走 unreachable
  const created = await (await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 't1', host: '127.0.0.1', port: 1, username: 'ops',
      authMethod: 'password', password: 'pw', exposeToAi: true, aiApprovalPolicy: 'readonly' }) })).json()
  assert.equal(created.server.name, 't1')
  assert.equal(created.server.hasPassword, true)
  assert.equal(created.server.password, undefined)

  // 列表脱敏:任何响应不得出现明文 pw
  const list = await (await fetch(`${BASE}/api/ssh/servers`, { headers: H })).json()
  assert.equal(list.servers.length, 1)
  assert.ok(!JSON.stringify(list).includes('"pw"'))

  // 校验失败 400
  const bad = await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H, body: JSON.stringify({ name: '' }) })
  assert.equal(bad.status, 400)

  // 试连(已保存行):stub 返回 unreachable(断言必有 errorKind+非 ok)
  const t = await (await fetch(`${BASE}/api/ssh/servers/${created.server.id}/test`, { method: 'POST', headers: H })).json()
  assert.equal(t.ok, false)
  assert.ok(t.errorKind)

  // 未保存表单试连
  const t2 = await (await fetch(`${BASE}/api/ssh/test`, { method: 'POST', headers: H,
    body: JSON.stringify({ host: '127.0.0.1', port: 1, username: 'ops', authMethod: 'password', password: 'x' }) })).json()
  assert.equal(t2.ok, false)

  // 更新(留空密码保持)+ PUT 非法 port 400 + 删除
  const up = await (await fetch(`${BASE}/api/ssh/servers/${created.server.id}`, { method: 'PUT', headers: H,
    body: JSON.stringify({ description: 'd2' }) })).json()
  assert.equal(up.server.description, 'd2')
  const badPort = await fetch(`${BASE}/api/ssh/servers/${created.server.id}`, { method: 'PUT', headers: H,
    body: JSON.stringify({ port: 99999 }) })
  assert.equal(badPort.status, 400)
  const del = await fetch(`${BASE}/api/ssh/servers/${created.server.id}`, { method: 'DELETE', headers: H })
  assert.equal(del.status, 200)
  assert.equal((await (await fetch(`${BASE}/api/ssh/servers`, { headers: H })).json()).servers.length, 0)
})

test('sshfile REST: dispatcher 顺序钉住 + name 穿越拒绝 + 未知 serverId 404', { timeout: 30000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // ① 无 token → 401:requirePlatform 在 sshfile 分支内部 —— 若请求被 /api/ssh/ 前缀吞掉
  //    (dispatcher 顺序错),这里会是落空的 40x 而非 401。401 即钉住分支可达。
  const noAuth = await fetch(`${BASE}/api/sshfile/list`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: 'x', path: '/' }) })
  assert.equal(noAuth.status, 401)

  // ② 带 token 但 serverId 不存在 → 404(materializeCreds 查无行)——再次证明进入 sshfile 分支
  const nf = await fetch(`${BASE}/api/sshfile/list`, { method: 'POST', headers: H,
    body: JSON.stringify({ serverId: 'no-such-server', path: '/' }) })
  assert.equal(nf.status, 404)

  // ③ 未知 serverId download → 404
  const dl = await fetch(`${BASE}/api/sshfile/download`, { method: 'POST', headers: H,
    body: JSON.stringify({ serverId: 'no-such-server', path: '/etc/hosts' }) })
  assert.equal(dl.status, 404)

  // ④ upload name 穿越/非法 → 400(校验先于 pool.acquire,无需真 sshd)
  for (const name of ['../evil', 'a/b', 'a\\b', '..', '.']) {
    const up = await fetch(`${BASE}/api/sshfile/upload?serverId=no-such-server&path=/tmp&name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'x-platform-token': login.token }, body: '' })
    assert.equal(up.status, 400, `name=${name}`)
  }

  // ⑤ 缺 serverId → 400
  const noSrv = await fetch(`${BASE}/api/sshfile/list`, { method: 'POST', headers: H,
    body: JSON.stringify({ path: '/' }) })
  assert.equal(noSrv.status, 400)
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
