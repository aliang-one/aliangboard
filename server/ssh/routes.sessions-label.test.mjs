// 会话标签 + serverName 随行(2026-09-27 跨 origin 名字连续性)路由单测:
// 另一 origin/浏览器凭 GET /api/ssh/sessions 快照还原显示名(label + serverName),
// PUT /api/ssh/sessions/:sid/label 是写侧(属主校验)。注入式夹具,不起真网关、不连 sshd。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createSshRoutes } from './routes.mjs'

function makeHarness({ sessions = [], terminalBySid = {}, serverRows = [], platformUser = null, adminUser = null } = {}) {
  const captured = { audit: [], labels: [], responses: [] }
  const routes = createSshRoutes({
    db: { prepare: () => ({ all: () => serverRows }) },   // 本夹具只触达 ssh_servers 名字查询
    sendJson: (res, status, body) => { captured.responses.push({ status, body }); res.finished = true },
    readBody: async () => captured.nextBody ?? {},
    requirePlatform: (req, res) => {
      if (!platformUser) { captured.responses.push({ status: 401, body: {} }); return null }
      return { username: platformUser }
    },
    requireAdmin: (req, res) => {
      if (!adminUser) { captured.responses.push({ status: 403, body: {} }); return null }
      return { username: adminUser }
    },
    writeAudit: (db, entry) => { captured.audit.push(entry) },
    listSshSessions: () => sessions,
    getSshTerminal: sid => terminalBySid[sid] || null,
    setSshSessionLabel: (sid, label) => { captured.labels.push([sid, label]); return { ok: true } },
    killSshSession: sid => (terminalBySid[sid] ? { ok: true } : null),
  })
  const call = async (method, pathname, body) => {
    captured.nextBody = body
    const res = {}
    const ok = await routes.handle({ method, headers: {} }, res, new URL(`http://gw${pathname}`))
    return { ok, res, ...captured.responses[captured.responses.length - 1] }
  }
  return { routes, captured, call }
}

test('GET /api/ssh/sessions:serverName 由 ssh_servers 表随行,label 原样下发(不再退裸 serverId)', async () => {
  const h = makeHarness({
    adminUser: 'liang',
    sessions: [
      { sid: 's1', serverId: 'sv-1', userId: 'liang', status: 'ATTACHED', browserCount: 1, idleMs: 5, label: '编译任务' },
      { sid: 's2', serverId: 'sv-9', userId: 'liang', status: 'DETACHED', browserCount: 0, idleMs: 99, label: '' },
    ],
    serverRows: [{ id: 'sv-1', name: 'web-1' }],   // sv-9 无行 → 回退 serverId
  })
  const out = await h.call('GET', '/api/ssh/sessions')
  assert.equal(out.status, 200)
  assert.equal(out.body.sessions[0].serverName, 'web-1')
  assert.equal(out.body.sessions[0].label, '编译任务')
  assert.equal(out.body.sessions[1].serverName, 'sv-9')      // 名字缺失不阻断观测
})

test('PUT /api/ssh/sessions/:sid/label:属主 200 且写侧生效;他人会话 403;未知 sid 404', async () => {
  const h = makeHarness({
    platformUser: 'liang',
    terminalBySid: { 's1': { owner: 'liang' }, 's9': { owner: 'someone-else' } },
  })
  const ok = await h.call('PUT', '/api/ssh/sessions/s1/label', { label: '  编译  ' })
  assert.equal(ok.status, 200)
  assert.deepEqual(h.captured.labels, [['s1', '  编译  ']])   // trim/截断在 service.setLabel
  assert.ok(h.captured.audit.some(e => e.verb === 'rename' && e.tool === 'ssh_session'))

  const foreign = await h.call('PUT', '/api/ssh/sessions/s9/label', { label: 'x' })
  assert.equal(foreign.status, 403)

  const missing = await h.call('PUT', '/api/ssh/sessions/no-such/label', { label: 'x' })
  assert.equal(missing.status, 404)
})

test('PUT label 分支不吞 DELETE:method 区分仍走手杀分支', async () => {
  const h = makeHarness({ adminUser: 'liang', terminalBySid: { 's1': { owner: 'liang' } } })
  const del = await h.call('DELETE', '/api/ssh/sessions/s1')
  assert.equal(del.status, 200)
  const delMissing = await h.call('DELETE', '/api/ssh/sessions/nope')
  assert.equal(delMissing.status, 404)
})
