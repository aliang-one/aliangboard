// /api/version + /api/version/check 契约:缓存 TTL/强制重查/网络降级/鉴权/hasUpdate 规则(2026-08-27 设计)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createVersionRoutes } from './routes/version.mjs'

const U = p => new URL(p, 'http://x')
const OK_TTL = 60 * 60_000
const ERR_TTL = 5 * 60_000

// okFetch:GitHub tags 响应桩。**真实形状 = 顶层 JSON 数组** [{name,commit,...}]
// (2026-08-28 生产事故:mock 曾凭猜写成 {tags:[...]}(registry 形状),实现跟着错,GitHub 恒解析出空)。
const okFetch = (names, calls = { n: 0 }) => {
  calls.n = 0
  return { calls, fn: async () => { calls.n++; return { ok: true, json: async () => names.map(name => ({ name, commit: { sha: 'x' } })) } } }
}

function harness({ fetchImpl, requirePlatform, current = '1.0.0', nowVal = 1_000_000 } = {}) {
  const sent = []
  let now = nowVal
  const routes = createVersionRoutes({
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    requirePlatform: requirePlatform || (() => ({ userId: 'u1' })),
    fetchImpl: fetchImpl || (async () => { throw new Error('no fetch stub') }),
    now: () => now,
    current,
  })
  return { routes, sent, tick: ms => { now += ms } }
}

test('未登录:GET/POST 均 401 且不触检出网', async () => {
  let called = 0
  const { routes, sent } = harness({
    fetchImpl: async () => { called++; return { ok: true, json: async () => ({}) } },
    requirePlatform: (r, s) => { sent.push({ status: 401 }); return null },
  })
  assert.equal(await routes.handle({ method: 'GET' }, null, U('/api/version')), true)
  assert.equal(await routes.handle({ method: 'POST' }, null, U('/api/version/check')), true)
  assert.equal(called, 0)
  assert.equal(sent.filter(x => x.status === 401).length, 2)
})

test('首次 GET 拉 GitHub 并缓存:窗口内二次 GET 不再出网;返回契约字段', async () => {
  const f = okFetch(['v1.0.7', 'v1.9.0', 'v1.10.0', 'nightly', 'v1.0.0-rc1'])
  const { routes, sent } = harness({ fetchImpl: f.fn })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(f.calls.n, 1)                          // 缓存命中
  const j = sent[1].json
  assert.equal(sent[1].status, 200)
  assert.equal(j.current, '1.0.0')
  assert.equal(j.latest, '1.10.0')                    // 过滤非 semver + 全量取最高
  assert.equal(j.hasUpdate, true)
  assert.equal(typeof j.checkedAt, 'number')
})

test('ok 缓存 1h 过期后重拉', async () => {
  const f = okFetch(['v1.0.7'])
  const { routes, tick } = harness({ fetchImpl: f.fn })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  tick(OK_TTL - 1)
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(f.calls.n, 1)                          // 未过期
  tick(1)
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(f.calls.n, 2)                          // 刚过期即重拉
})

test('POST check 强制绕过缓存', async () => {
  const f = okFetch(['v1.0.7'])
  const { routes } = harness({ fetchImpl: f.fn })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  await routes.handle({ method: 'POST' }, null, U('/api/version/check'))
  assert.equal(f.calls.n, 2)
})

test('网络失败/非 200:降级 latest:null 恒 200;错误态 5min 内不重试、过期重试', async () => {
  let fail = true
  const calls = { n: 0 }
  const { routes, sent, tick } = harness({
    fetchImpl: async () => { calls.n++; if (fail) throw new Error('offline'); return { ok: true, json: async () => ([{ name: 'v1.2.0' }]) } },
  })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual({ latest: sent[0].json.latest, hasUpdate: sent[0].json.hasUpdate }, { latest: null, hasUpdate: false })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(calls.n, 1)                            // 错误缓存期内不再撞超时
  tick(ERR_TTL - 1)
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(calls.n, 1)                            // 仍在内
  tick(1)
  fail = false
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(calls.n, 2)
  assert.equal(sent[3].json.latest, '1.2.0')          // 恢复
})

test('GitHub 403(限流)同样降级 latest:null', async () => {
  const { routes, sent } = harness({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].json.latest, null)
})

test('hasUpdate 规则:dev 恒 false;latest<=current false;严格大于才 true', async () => {
  const mk = (current, names) => {
    const f = okFetch(names)
    const h = harness({ fetchImpl: f.fn, current })
    return h
  }
  let h = mk('dev', ['v9.9.9'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, false)       // dev 不比版本

  h = mk('1.2.0', ['v1.1.0'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, false)       // current > latest

  h = mk('1.2.0', ['v1.2.0'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, false)       // 等值不提示

  h = mk('1.2.0', ['v1.2.1'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, true)
})

test('非匹配路径返回 false(不拦截后续分发)', async () => {
  const { routes } = harness({})
  assert.equal(await routes.handle({ method: 'GET' }, null, U('/api/other')), false)
})
