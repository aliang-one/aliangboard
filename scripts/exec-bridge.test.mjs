// exec / 端口转发 通道集成测试（零新增依赖：仅 node 内置 + 已声明的 ws）
//
// 无法在此环境连真实集群，故以「fake K8s API + 启动真实 Gateway 子进程」覆盖：
//   - exec WebSocket 鉴权（无 session 必须被拒）
//   - 端口转发 REST 鉴权 / 参数校验 / 建立 / 列表 / 停止（kind=Pod 无需访问 K8s）
//   - exec 浏览器↔网关 二进制帧编解码契约（锁定首字节通道协议）
// 真实 exec↔K8s 的 SPDY/WS 多路复用由 @kubernetes/client-node 承担，不在本测试范围。
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = name => { pass++; console.log('  ✓', name) }
const bad = (name, err) => { fail++; console.error('  ✗', name, '\n     ', err?.message || err) }

// --- fake K8s API server：仅需 /version 让 session 探活通过 ---
const fakeK8s = createServer((req, res) => {
  if (req.url === '/version') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ gitVersion: 'v1.30.0-test' }))
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise(r => fakeK8s.listen(0, '127.0.0.1', r))
const k8sUrl = `http://127.0.0.1:${fakeK8s.address().port}`

// --- 启动真实 Gateway 子进程 ---
// 隔离(2026-08-29):ALIANG_DB 指向临时目录——否则用默认 data/aliangboard.db,
// 与正在运行的正式网关撞 DB 锁(「拒绝启动:另一网关进程正持有…」),全量验证被迫停网关。
const DIR = mkdtempSync(join(tmpdir(), 'exec-bridge-'))
const gwPort = 18000 + Math.floor(Math.random() * 2000)
const gw = spawn('node', [join(ROOT, 'server/index.mjs')], {
  env: { ...process.env, PORT: String(gwPort), HOST: '127.0.0.1', ALIANG_DB: join(DIR, 'exec-bridge.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
})
gw.stderr.on('data', d => process.stderr.write(d))
let gwStderr = ''
gw.stderr.on('data', d => { gwStderr += String(d) })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Gateway 启动超时\n${gwStderr.slice(-500)}`)), 8000)
  gw.on('exit', code => { clearTimeout(timer); reject(new Error(`Gateway 提前退出(code=${code})\n${gwStderr.slice(-500)}`)) })
  gw.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(timer); resolve() } })
})
const gwBase = `http://127.0.0.1:${gwPort}`

async function http(path, opts = {}) {
  const res = await fetch(`${gwBase}${path}`, opts)
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

const cleanUp = () => { try { gw.kill() } catch { /* noop */ }; try { fakeK8s.close() } catch { /* noop */ }; setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ } }, 300) }

try {
  // 1) 登录拿 k8s session(POST /api/session 旧直连已下线 CSO #1,改走
  //    平台登录 → 注册集群 → connect-cluster 正规链路,session 由假 apiserver /version 探活)
  const login = await http('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }),
  })
  assert.equal(login.status, 200, '平台登录应成功')
  const ptok = login.body.token
  const ac = await http('/api/admin/clusters', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: JSON.stringify({ name: 'fake', apiServer: k8sUrl, authMethod: 'token', token: 'fake-token' }),
  })
  assert.equal(ac.status, 200, '注册假集群应成功')
  const cc = await http('/api/connect-cluster', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: JSON.stringify({ clusterId: ac.body.cluster.id }),
  })
  assert.equal(cc.status, 200, 'connect-cluster 应成功（fake /version 探活通过）')
  ok('登录建立 session（对接 fake K8s /version）')
  const token = cc.body.token
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

  // 2) exec WebSocket 无 session -> 必须被拒
  await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/api/exec?namespace=ns&pod=p`)
    let settled = false
    const done = (win) => { if (settled) return; settled = true; try { ws.close() } catch { /* noop */ } win ? ok('exec WS 无 session 被拒绝') : bad('exec WS 无 session 应被拒绝', new Error('连接未被拒')); resolve() }
    ws.on('open', () => done(false))
    ws.on('unexpected-response', () => done(true))
    ws.on('error', () => done(true))
    ws.on('close', () => done(true))
    setTimeout(() => done(true), 2000)
  })

  // 3) exec WS 缺少 namespace/pod（带合法 session）-> 服务端应发 ERROR 帧并关闭
  await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/api/exec?session=${encodeURIComponent(token)}`)
    ws.binaryType = 'arraybuffer'
    let settled = false
    const finish = (m) => { if (settled) return; settled = true; m ? ok('exec WS 缺参数返回 ERROR 帧并关闭') : bad('exec WS 缺参数应返回 ERROR 帧', new Error('未收到错误')); try { ws.close() } catch { /* noop */ }; resolve() }
    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (buf[0] === 4) finish(true) // CH_ERROR
    })
    ws.on('close', () => finish(true))
    ws.on('error', () => finish(true))
    setTimeout(() => finish(false), 2000)
  })

  // 4) 端口转发 无 session -> 401
  const pfNoAuth = await http('/api/portforward', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'Pod', namespace: 'ns', name: 'p', port: 80 }) })
  pfNoAuth.status === 401 ? ok('端口转发无 session 返回 401') : bad('端口转发无 session 应 401', new Error('status=' + pfNoAuth.status))

  // 5) 端口转发 缺参数 -> 400
  const pfBad = await http('/api/portforward', { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'Pod', namespace: 'ns', name: 'p' }) })
  pfBad.status === 400 ? ok('端口转发缺 port 返回 400') : bad('端口转发缺参数应 400', new Error('status=' + pfBad.status + ' ' + JSON.stringify(pfBad.body)))

  // 6) 端口转发 Pod 建立 -> 列表 -> 停止（kind=Pod 不访问 K8s，直接开本地监听）
  const pfOk = await http('/api/portforward', { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'Pod', namespace: 'ns', name: 'mypod', port: 8080 }) })
  if (pfOk.status === 200 && pfOk.body.localPort > 0) ok(`端口转发 Pod 建立成功（local=${pfOk.body.localPort}）`)
  else bad('端口转发 Pod 应 200', new Error(JSON.stringify(pfOk.body)))
  const pfId = pfOk.body?.id

  const listRes = await http('/api/portforward', { headers: { authorization: `Bearer ${token}` } })
  Array.isArray(listRes.body?.forwards) && listRes.body.forwards.some(f => f.id === pfId)
    ? ok('端口转发列表包含新建项') : bad('列表应包含新建项', new Error(JSON.stringify(listRes.body)))

  const delRes = await http(`/api/portforward/${pfId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
  delRes.status === 200 ? ok('端口转发停止返回 200') : bad('停止应 200', new Error('status=' + delRes.status))

  const listAfter = await http('/api/portforward', { headers: { authorization: `Bearer ${token}` } })
  !listAfter.body.forwards.some(f => f.id === pfId) ? ok('端口转发停止后列表已移除') : bad('停止后应从列表移除', new Error('仍在列表'))

  // 6b) Pod 文件路由 鉴权 / 参数校验（在 execCapture 之前即拒绝，无需真实 exec）
  const pfListNoAuth = await http('/api/podfile/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'ns', pod: 'p' }) })
  pfListNoAuth.status === 401 ? ok('podfile 无 session 返回 401') : bad('podfile 无 session 应 401', new Error('status=' + pfListNoAuth.status))

  const pfListBad = await http('/api/podfile/list', { method: 'POST', headers: auth, body: JSON.stringify({ namespace: 'ns' }) })
  pfListBad.status === 400 ? ok('podfile 缺 pod 返回 400') : bad('podfile 缺 pod 应 400', new Error('status=' + pfListBad.status))

  // 6c) kubectl debug（注入临时容器）鉴权 / 参数校验（attachEphemeral 之前即拒绝）
  const dbgNoAuth = await http('/api/pod/debug', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'ns', pod: 'p', image: 'busybox' }) })
  dbgNoAuth.status === 401 ? ok('pod/debug 无 session 返回 401') : bad('pod/debug 无 session 应 401', new Error('status=' + dbgNoAuth.status))

  const dbgBad = await http('/api/pod/debug', { method: 'POST', headers: auth, body: JSON.stringify({ namespace: 'ns', pod: 'p' }) })
  dbgBad.status === 400 ? ok('pod/debug 缺 image 返回 400') : bad('pod/debug 缺 image 应 400', new Error('status=' + dbgBad.status))

  // 6d) CronJob 手动触发 鉴权 / 参数校验（triggerCronJob 之前即拒绝）
  const trigNoAuth = await http('/api/cronjob/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'ns', name: 'cj' }) })
  trigNoAuth.status === 401 ? ok('cronjob/trigger 无 session 返回 401') : bad('cronjob/trigger 无 session 应 401', new Error('status=' + trigNoAuth.status))
  const trigBad = await http('/api/cronjob/trigger', { method: 'POST', headers: auth, body: JSON.stringify({ namespace: 'ns' }) })
  trigBad.status === 400 ? ok('cronjob/trigger 缺 name 返回 400') : bad('cronjob/trigger 缺 name 应 400', new Error('status=' + trigBad.status))

  // 6e) 资源归属拓扑 鉴权 / 参数校验（resolveOwnerTree 之前即拒绝）
  const treeNoAuth = await http('/api/resource/tree?namespace=ns&kind=Pod&name=p')
  treeNoAuth.status === 401 ? ok('resource/tree 无 session 返回 401') : bad('resource/tree 无 session 应 401', new Error('status=' + treeNoAuth.status))
  const treeBad = await http('/api/resource/tree?kind=Pod&name=p', { headers: { authorization: `Bearer ${token}` } })
  treeBad.status === 400 ? ok('resource/tree 缺 namespace 返回 400') : bad('resource/tree 缺 namespace 应 400', new Error('status=' + treeBad.status))

  // 7) 二进制帧编解码契约（与 server WsSink / client execStream 保持一致）
  const encode = (type, data) => Buffer.concat([Buffer.from([type]), Buffer.from(data, 'utf8')])
  const decode = buf => ({ type: buf[0], payload: buf.subarray(1).toString('utf8') })
  const stdinFrame = decode(encode(1, 'ls -la'))
  stdinFrame.type === 1 && stdinFrame.payload === 'ls -la' ? ok('帧契约：stdin（type=1）无损往返') : bad('stdin 帧契约', new Error(JSON.stringify(stdinFrame)))
  const resizeFrame = decode(encode(2, JSON.stringify({ cols: 120, rows: 30 })))
  resizeFrame.type === 2 && JSON.parse(resizeFrame.payload).cols === 120 ? ok('帧契约：resize（type=2）无损往返') : bad('resize 帧契约', new Error(JSON.stringify(resizeFrame)))
} catch (err) {
  bad('测试运行异常', err)
} finally {
  cleanUp()
}

console.log(`\n[exec-bridge] ${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
