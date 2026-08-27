// T1 / T16 测试:调用上下文抽象(node:test,零新依赖)。
// 锁定 buildCallContext 返回的形状(6 条 kube 路径吃的契约)+ getDispatcher 缓存语义 + 身份隔离。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  normalizeServer, getDispatcher, buildCallContext,
  _clearDispatcherCacheForTest, _dispatcherCacheSizeForTest, _setAllowedHostsForTest,
} from './call-context.mjs'

// 测试不受部署环境 K8S_ALLOWED_HOSTS 影响
_setAllowedHostsForTest(new Set())

// --- normalizeServer ---
test('normalizeServer: 合法 http/https 通过、非根路径去尾斜杠;非法协议抛错', () => {
  // 根路径尾斜杠由 URL 规范保留(空 pathname 还原为 /),非根路径才去尾斜杠
  assert.equal(normalizeServer('https://10.0.0.1:6443/api/').toString(), 'https://10.0.0.1:6443/api', '非根路径去尾斜杠')
  assert.equal(normalizeServer('https://10.0.0.1:6443').hostname, '10.0.0.1')
  assert.equal(normalizeServer('http://localhost:8080').protocol, 'http:')
  assert.throws(() => normalizeServer('ftp://x'), /http 或 https/)
  assert.throws(() => normalizeServer('not-a-url'))
})

// --- getDispatcher 缓存:同 TLS 配置复用 agent ---
test('getDispatcher: 同 TLS 配置命中同一 agent;不同配置不同 agent', () => {
  _clearDispatcherCacheForTest()
  const a1 = getDispatcher({ ca: 'CA-A', insecure: false })
  const a2 = getDispatcher({ ca: 'CA-A', insecure: false })
  const b = getDispatcher({ ca: 'CA-B', insecure: false })
  const c = getDispatcher({ ca: 'CA-A', insecure: true })
  assert.equal(a1, a2, '同 TLS 配置应复用同一 agent 实例(缓存命中)')
  assert.notEqual(a1, b, '不同 ca 应得不同 agent')
  assert.notEqual(a1, c, '不同 insecure 应得不同 agent')
  assert.ok(_dispatcherCacheSizeForTest() >= 3)
})

// --- 身份隔离(T1 安全关键):client-cert 身份必须分到独立 agent,不能混用 ---
test('getDispatcher: 不同 client-cert 身份(cert/key)分到不同 agent(身份隔离)', () => {
  _clearDispatcherCacheForTest()
  const tokenOnly = getDispatcher({ insecure: false })                    // 纯 Bearer(无 cert)
  const certUser1 = getDispatcher({ cert: 'CERT1', key: 'KEY1', insecure: false })
  const certUser2 = getDispatcher({ cert: 'CERT2', key: 'KEY2', insecure: false })
  assert.notEqual(tokenOnly, certUser1, 'token 与 client-cert 应隔离')
  assert.notEqual(certUser1, certUser2, '不同 client-cert 身份应隔离(防跨身份凭证复用)')
})

// --- buildCallContext 形状契约(回归核心:6 条 kube 路径吃的形状不能变)---
test('buildCallContext: 返回 {apiServer(URL), authHeader, ca, cert, key, insecure, dispatcher}', () => {
  const ctx = buildCallContext({ apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer xyz', ca: 'CA', cert: null, key: null, insecure: false })
  assert.ok(ctx.apiServer instanceof URL, 'apiServer 必须是 URL')
  assert.equal(ctx.apiServer.protocol, 'https:')
  assert.equal(ctx.authHeader, 'Bearer xyz')
  assert.equal(ctx.ca, 'CA')
  assert.equal(ctx.cert, null)
  assert.equal(ctx.key, null)
  assert.equal(ctx.insecure, false)
  assert.ok(ctx.dispatcher, 'dispatcher 必须存在(undici Agent)')
})

test('buildCallContext: apiServer 传 URL 原样保留(同引用);传字符串规范化', () => {
  const url = normalizeServer('https://10.0.0.1:6443')
  const ctx = buildCallContext({ apiServer: url, authHeader: null, insecure: true })
  assert.equal(ctx.apiServer, url, '传 URL 应原样保留(同引用,不重复构造)')
  const ctx2 = buildCallContext({ apiServer: 'https://10.0.0.1:6443/api/', authHeader: null, insecure: false })
  assert.equal(ctx2.apiServer.toString(), 'https://10.0.0.1:6443/api', '字符串非根路径去尾斜杠')
})

test('buildCallContext: authHeader 空/undefined 归一为 null(insecure 归一为 bool)', () => {
  const ctx = buildCallContext({ apiServer: 'https://10.0.0.1', authHeader: undefined, insecure: 0 })
  assert.equal(ctx.authHeader, null)
  assert.strictEqual(ctx.insecure, false)
})

// --- 回归(T16):浏览器 session 与 API-key 共用 buildCallContext → 形状等价 →
//     requestKubernetes(session)/buildKubeConfig(session)/流式(session) 都能吃 API-key 构造的上下文 ---
test('回归: API-key 风格上下文(现签 SA token)与浏览器 session 形状等价', () => {
  const browserSession = buildCallContext({ apiServer: 'https://10.0.0.1', authHeader: 'Bearer admin-token', insecure: false })
  const apiKeyCtx = buildCallContext({ apiServer: 'https://10.0.0.1', authHeader: 'Bearer sa-minted-token', insecure: false })
  // 6 条 kube 路径读的字段都在,且形状一致
  for (const k of ['apiServer', 'authHeader', 'ca', 'cert', 'key', 'insecure', 'dispatcher']) {
    assert.ok(k in browserSession, `浏览器 session 缺字段 ${k}`)
    assert.ok(k in apiKeyCtx, `API-key 上下文缺字段 ${k}`)
  }
  assert.equal(typeof browserSession.authHeader, typeof apiKeyCtx.authHeader)
  assert.ok(browserSession.dispatcher && apiKeyCtx.dispatcher)
})

// ── 2026-08-27:requestOnce body 解析的 content-type 感知(根因:结构化日志端点被无脑
// JSON.parse 成对象,MCP/WB get_pod_logs String(obj) 变 "[object Object]")──
// 语义:ct 含 json → 解析;ct 明示非 json(text/plain、application/yaml)→ 保持文本;
// 无 ct(代理剥头)→ 维持旧的「尝试解析」兼容行为;空文本 → null。
test('parseResponseBody:json ct 解析对象;text/plain 的合法 JSON 文本保持字符串;无 ct 兼容旧解析', async () => {
  const { parseResponseBody } = await import('./call-context.mjs')
  const jsonText = '{"kind":"Pod","metadata":{"name":"p1"}}'
  const logJsonLine = '{"level":"error","msg":"boom"}'
  assert.equal(parseResponseBody(jsonText, 'application/json').kind, 'Pod', 'application/json → 解析')
  assert.equal(parseResponseBody(jsonText, 'application/json; charset=utf-8').kind, 'Pod', '带 charset 也解析')
  assert.equal(typeof parseResponseBody(logJsonLine, 'text/plain'), 'string', 'text/plain + 合法 JSON 日志行 → 保持字符串(根因修复)')
  assert.equal(parseResponseBody(logJsonLine, 'text/plain; charset=utf-8'), logJsonLine, '原文不变')
  assert.equal(parseResponseBody('apiVersion: v1\nkind: Pod\n', 'application/yaml'), 'apiVersion: v1\nkind: Pod\n', 'yaml ct → 文本')
  assert.equal(parseResponseBody(jsonText).kind, 'Pod', '无 ct → 兼容旧行为尝试解析')
  assert.equal(parseResponseBody(jsonText, '').kind, 'Pod', '空 ct 视同无 ct(尝试解析)')
  assert.equal(parseResponseBody('plain text', 'application/json'), 'plain text', 'json ct 但解析失败 → 原文本(旧行为)')
  assert.equal(parseResponseBody('', 'application/json'), null, '空文本 → null')
  assert.equal(parseResponseBody(null, 'application/json'), null, 'null → null')
})
