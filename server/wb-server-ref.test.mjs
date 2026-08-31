// @server 搜索端点集成测试:spawn 真网关(骨架逐字照 wb-project-cluster.test.mjs)。
// 覆盖:server 分支 exposedOnly + name/host/description 三路命中 + host 仅 admin;
// 未绑集群项目可用;K8s 分支 admin 门不回退。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW_PORT = 55000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'wb-server-ref-'))

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'wb.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

test('@server 搜索:exposedOnly+三路命中+host 仅 admin;未绑集群可用;K8s 分支门不回退', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }
  // 未绑定集群建项目(clusterId 缺省,wb-project-cluster 特性)
  const proj = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'ref-p' }) })).json()
  const pid = proj.project.id
  // 直插两台服务器:一台 exposed(gw/10.0.0.1),一台未暴露(hidden/10.0.0.2)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DIR, 'wb.db'))
  const ins = db.prepare('INSERT INTO ssh_servers (id,name,host,port,username,authMethod,description,clusterRef,exposeToAi,aiApprovalPolicy,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('s1', '网关机', '10.0.0.1', 22, 'ops', 'password', '入口网关', 'ck-t1', 1, 'readonly', 'ok', Date.now(), Date.now())
  ins.run('s2', '隐藏机', '10.0.0.2', 22, 'ops', 'password', '不该出现', '', 0, 'always', 'ok', Date.now(), Date.now())
  db.close()

  // admin:name/host/备注 三路命中;未暴露不可见;host 字段在
  const byName = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('网关')}`, { headers: H })).json()
  assert.equal(byName.items.length, 1); assert.equal(byName.items[0].name, '网关机'); assert.equal(byName.items[0].host, '10.0.0.1')
  const byIp = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=10.0.0.1`, { headers: H })).json()
  assert.equal(byIp.items.length, 1)
  const byDesc = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('入口')}`, { headers: H })).json()
  assert.equal(byDesc.items.length, 1)

  // 平台用户:可见 exposed;命中同样工作;响应无 host 字段
  const mk = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })
  assert.ok([200, 201].includes(mk.status))
  const plogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })).json()
  const PH = { 'content-type': 'application/json', 'x-platform-token': plogin.token }
  const pRes = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=10.0.0.1`, { headers: PH })).json()
  assert.equal(pRes.items.length, 1)
  assert.equal('host' in pRes.items[0], false, '非 admin 响应不得携带 host')
  const pHidden = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('隐藏')}`, { headers: PH })).json()
  assert.equal(pHidden.items.length, 0, '未暴露服务器不可见')

  // K8s 分支回归:非 admin → 401/403(requireAdmin 仍在);server 分支放行不等于 K8s 分支放行
  const k8sGate = await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=pod&q=x`, { headers: PH })
  assert.ok([401, 403].includes(k8sGate.status))
})

// 终审 Important#1 回归:buildRefsContext 的 server 分支必须 push null 占位,
// 保持 fetchedResources 与 references 下标一一对应——否则 @server+@pod 混用时
// server chip 挂上别人的 ResourceCard、K8s ref resource=null。
test('buildRefsContext server 分支:@server+@pod 混传 refs/resources 下标不串位', { timeout: 60000 }, async () => {
  const K8S_PORT = 41000 + Math.floor(Math.random() * 2000)
  const GW2 = 44000 + Math.floor(Math.random() * 2000)
  const DIR2 = mkdtempSync(join(tmpdir(), 'wb-server-ref2-'))
  const LLM_PORT = K8S_PORT + 1
  // mock K8s:pod 单查路径回一个 Pod body;mock LLM:直接终答(本测不关心 agent 输出)
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31","gitVersion":"v1.31.4"}') }
    if (p.endsWith('/pods/nginx')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ kind: 'Pod', metadata: { name: 'nginx', namespace: 'default' }, spec: { containers: [] } })) }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"nf ${p}"}`)
  })
  const llm = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
  })
  await new Promise(r => k8s.listen(K8S_PORT, '127.0.0.1', r))
  await new Promise(r => llm.listen(LLM_PORT, '127.0.0.1', r))
  const gw2 = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(GW2), ALIANG_DB: join(DIR2, 'wb.db'),
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR2, ALIANG_WORKBENCH_DIR: join(DIR2, 'wb') },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const BASE2 = `http://127.0.0.1:${GW2}`
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${BASE2}/api/health`); break } catch { await new Promise(r => setTimeout(r, 300)) } }
    const login = await (await fetch(`${BASE2}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H2 = { 'content-type': 'application/json', 'x-platform-token': login.token }
    await fetch(`${BASE2}/api/admin/llm-config`, { method: 'PUT', headers: H2, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user:\n    token: d\n`
    const cr = await (await fetch(`${BASE2}/api/admin/clusters`, { method: 'POST', headers: H2, body: JSON.stringify({ name: 'mock-k8s', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE2}/api/workbench/projects`, { method: 'POST', headers: H2, body: JSON.stringify({ name: 'mix-ref', clusterId: cr.cluster?.id || cr.id }) })).json()
    const references = [
      { kind: 'server', namespace: '', name: '网关机' },
      { kind: 'pod', namespace: 'default', name: 'nginx' },
    ]
    const cv = await (await fetch(`${BASE2}/api/workbench/conversations`, { method: 'POST', headers: H2,
      body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '看下', references }) })).json()
    // 响应级 references:server 位为 null 占位,pod 位是真实 body(不串位)
    assert.equal(cv.references.length, 2, 'references 长度须与入参一致')
    assert.equal(cv.references[0], null, 'server ref 的 resources 槽位必须是 null 占位')
    assert.equal(cv.references[1]?.kind, 'Pod', 'pod ref 的 resource 不得被 server 挤掉')
    assert.equal(cv.references[1]?.metadata?.name, 'nginx')
    // 落库回读:GET /conversations/:id 的 messages 内 user 行 refs 同一下标对齐
    const conv = await (await fetch(`${BASE2}/api/workbench/conversations/${cv.id}`, { headers: H2 })).json()
    const userMsg = (conv.messages || []).find(m => m.role === 'user')
    assert.ok(userMsg, '须有 user 消息行')
    const refs = JSON.parse(userMsg.refs || '[]')
    assert.equal(refs.length, 2)
    assert.equal(refs[0].resource, null, 'server ref 落库 resource 须为 null')
    assert.equal(refs[1].resource?.kind, 'Pod', 'pod ref 落库 resource 须是 Pod,不串位')
  } finally {
    try { gw2.kill('SIGKILL') } catch { /* noop */ }
    try { k8s.close() } catch { /* noop */ }
    try { llm.close() } catch { /* noop */ }
    try { rmSync(DIR2, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

// teardown:与 wb-project-cluster.test.mjs 一致,SIGKILL + rmSync
test.after(() => {
  try { gw.kill('SIGKILL') } catch { /* noop */ }
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

// 2026-08-31 工具链审计修复①:buildRefsContext 的「空响应」(body==null)与「拉取失败」(catch)
// 分支此前只 push blocks 不 push resources 占位,违反本函数不变式(fetchedResources 与
// references 下标一一对应)——后续 K8s ref 的 ResourceCard 全部张冠李戴错一位。
// 终审 Important#1 只修了 @server 分支;本测锁空响应+catch 两分支。
test('buildRefsContext 空响应/拉取失败分支:resources 补 null 占位不串位', { timeout: 60000 }, async () => {
  const K8S_PORT = 41000 + Math.floor(Math.random() * 2000)
  const GW3 = 44000 + Math.floor(Math.random() * 2000)
  const DIR3 = mkdtempSync(join(tmpdir(), 'wb-server-ref3-'))
  const LLM_PORT = K8S_PORT + 1
  // mock K8s:empty-pod 回 200 空 body;ghost-pod 回 404;ok-pod 回正常 Pod
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31","gitVersion":"v1.31.4"}') }
    if (p.endsWith('/pods/ok-pod')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ kind: 'Pod', metadata: { name: 'ok-pod', namespace: 'default' }, spec: { containers: [] } })) }
    if (p.endsWith('/pods/empty-pod')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('') }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"kind":"Status","message":"nf"}')
  })
  const llm = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
  })
  await new Promise(r => k8s.listen(K8S_PORT, '127.0.0.1', r))
  await new Promise(r => llm.listen(LLM_PORT, '127.0.0.1', r))
  const gw3 = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(GW3), ALIANG_DB: join(DIR3, 'wb.db'),
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR3, ALIANG_WORKBENCH_DIR: join(DIR3, 'wb') },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const BASE3 = `http://127.0.0.1:${GW3}`
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${BASE3}/api/health`); break } catch { await new Promise(r => setTimeout(r, 300)) } }
    const login = await (await fetch(`${BASE3}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H3 = { 'content-type': 'application/json', 'x-platform-token': login.token }
    await fetch(`${BASE3}/api/admin/llm-config`, { method: 'PUT', headers: H3, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user:\n    token: d\n`
    const cr = await (await fetch(`${BASE3}/api/admin/clusters`, { method: 'POST', headers: H3, body: JSON.stringify({ name: 'mock-k8s-3', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE3}/api/workbench/projects`, { method: 'POST', headers: H3, body: JSON.stringify({ name: 'gap-ref', clusterId: cr.cluster?.id || cr.id }) })).json()
    const references = [
      { kind: 'pod', namespace: 'default', name: 'empty-pod' },
      { kind: 'pod', namespace: 'default', name: 'ghost-pod' },
      { kind: 'pod', namespace: 'default', name: 'ok-pod' },
    ]
    const cv = await (await fetch(`${BASE3}/api/workbench/conversations`, { method: 'POST', headers: H3,
      body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '看下', references }) })).json()
    // 三槽位一一对应:空响应→null,404→null,正常→真实 body(ok-pod 不得被挤到下标 0)
    assert.equal(cv.references.length, 3, `references 长度须与入参一致,收到 ${cv.references.length}`)
    assert.equal(cv.references[0], null, '空响应 ref 的 resources 槽位必须是 null 占位')
    assert.equal(cv.references[1], null, '拉取失败 ref 的 resources 槽位必须是 null 占位')
    assert.equal(cv.references[2]?.metadata?.name, 'ok-pod', 'ok-pod 的 ResourceCard 不得被前面失败项挤掉')
    // 落库回读:messages 内 user 行 refs 下标同对齐
    const conv = await (await fetch(`${BASE3}/api/workbench/conversations/${cv.id}`, { headers: H3 })).json()
    const userMsg = (conv.messages || []).find(m => m.role === 'user')
    const refs = JSON.parse(userMsg.refs || '[]')
    assert.equal(refs.length, 3)
    assert.equal(refs[0].resource, null)
    assert.equal(refs[1].resource, null)
    assert.equal(refs[2].resource?.metadata?.name, 'ok-pod', '落库 resource 不串位')
  } finally {
    try { gw3.kill('SIGKILL') } catch { /* noop */ }
    try { k8s.close() } catch { /* noop */ }
    try { llm.close() } catch { /* noop */ }
    try { rmSync(DIR3, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
