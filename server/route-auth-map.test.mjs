// 路由鉴权门守卫测试(2026-08-28 架构治理第二项):守卫三件套——
//   ① 机制:createAuthGate 按 class 分发验证器,none 放行、未知 class fail-closed;
//   ② allowlist 精确性:'none'(公有)条目集合必须与显式清单完全一致,多一条都是事故;
//   ③ 静态完整性:扫 index.mjs + routes/*.mjs 全部路径字面量,任何 handler 路径必须已在
//     ROUTE_AUTH 登记——今后往 if-链加路由不登记,这里直接红(2026-08-28 registry/tags 漏鉴权的结构性根治)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_AUTH, authClassFor, createAuthGate } from './route-auth-map.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------- ① 机制 ----------
test('authClassFor:精确/前缀/方法匹配语义', () => {
  assert.equal(authClassFor('GET', '/api/health'), 'none')
  assert.equal(authClassFor('POST', '/api/auth/login'), 'none')
  assert.equal(authClassFor('POST', '/api/session'), undefined, '旧直连建会话已下线(CSO #1:未认证 SSRF 链)')
  assert.equal(authClassFor('GET', '/api/session'), 'session', '同路径不同方法不同 class')
  assert.equal(authClassFor('GET', '/api/terminals'), 'session')
  assert.equal(authClassFor('PATCH', '/api/terminals/xyz'), 'session', '前缀条目吃子路径')
  assert.equal(authClassFor('GET', '/api/k8s-watch'), 'session')
  assert.equal(authClassFor('GET', '/api/k8s/api/v1/pods'), 'session')
  assert.equal(authClassFor('POST', '/api/registry/tags'), 'session', '审计 #2:曾漏挂,现须 session')
  assert.equal(authClassFor('POST', '/api/admin/users'), 'admin')
  assert.equal(authClassFor('GET', '/api/workbench/records'), 'platform', 'workbench 混合层地板=platform')
  assert.equal(authClassFor('POST', '/api/key/x/call'), 'apikey')
  // 未登记 → undefined(门将 404,强制登记)
  assert.equal(authClassFor('GET', '/api/brand-new-endpoint'), undefined)
  assert.equal(authClassFor('POST', '/api/health'), undefined, '方法不匹配视同未登记')
})

test('createAuthGate:none 恒放行;验证器拒即门拒;未知 class fail-closed', async () => {
  const denied = []
  const res = { code: 0, body: null, written(status, payload) { this.code = status; this.body = payload } }
  const verifiers = {
    session: () => { denied.push('session'); return false },
    platform: () => true,
    admin: () => true,
    apikey: () => true,
    mcp: () => true,
  }
  const gate = createAuthGate({ sendJson: (r, s, p) => res.written(s, p), verifiers })
  assert.equal(await gate('none', {}, res), true, 'none 不调验证器直接放行')
  assert.equal(await gate('session', {}, res), false, '验证器拒 → 门拒')
  assert.deepEqual(denied, ['session'])
  // 未知 class:fail-closed + 500(配置 bug 要吵,不能静默放行)
  assert.equal(await gate('yolo', {}, res), false)
  assert.ok(res.code >= 400, '未知 class 必须拒绝')
})

// ---------- ② allowlist 精确性 ----------
test('公有(none)路由集合与显式清单逐项一致——多一条都是事故', () => {
  const noneSet = ROUTE_AUTH.filter(r => r.auth === 'none').map(r => `${r.method || '*'} ${r.pattern ?? r.prefix}`).sort()
  assert.deepEqual(noneSet, [
    'DELETE /api/session',   // 幂等登出:无 token 也 204
    'GET /api/health',       // 存活探针
    'POST /api/auth/login',
    'POST /api/auth/logout',
  ])
})

test('表自身合法性:auth ∈ 已知集合;prefix/pattern 二选一;method 合法大写', () => {
  const known = new Set(['none', 'session', 'platform', 'admin', 'apikey', 'mcp'])
  for (const r of ROUTE_AUTH) {
    assert.ok(known.has(r.auth), `未知 auth class: ${JSON.stringify(r)}`)
    assert.ok((r.pattern != null) !== (r.prefix != null), `prefix/pattern 必须二选一: ${JSON.stringify(r)}`)
    if (r.method) assert.ok(/^[A-Z]+$/.test(r.method), `method 须大写 HTTP 动词: ${JSON.stringify(r)}`)
  }
})

// ---------- ③ 静态完整性交叉(强制登记的牙齿) ----------
// 抽取 dispatch 源码里的路径字面量:pathname === '/x'(无括号)/ pathname.startsWith('/x')
function extractPathLiterals(source) {
  const out = new Set()
  const re = /url\.pathname\s*(?:===\s*'([^']+)'|startsWith\(\s*'([^']+)'\))/g
  let m
  while ((m = re.exec(source))) out.add(m[1] || m[2])
  return out
}

test('index.mjs + routes/*.mjs 的每个路径字面量都已登记(不登记→404+本测试红)', () => {
  const files = [join(HERE, 'index.mjs'), ...readdirSync(join(HERE, 'routes')).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map(f => join(HERE, 'routes', f))]
  const literals = new Set()
  for (const f of files) for (const p of extractPathLiterals(readFileSync(f, 'utf8'))) literals.add(p)
  assert.ok(literals.size >= 40, `路径字面量抽取异常(仅 ${literals.size} 条,检查正则)`)
  const unregistered = [...literals].filter(p => {
    // 任一 method 命中即算已登记(method 无关的前缀语义)
    for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      if (authClassFor(verb, p) !== undefined) return false
    }
    return true
  })
  assert.deepEqual(unregistered, [], `以下 handler 路径未在 ROUTE_AUTH 登记(门外必 404):${unregistered.join(', ')}`)
})
