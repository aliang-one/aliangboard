// 纯层契约:X509 描述符(不含 PEM)/ 日期解析兜底 / TLS 错误归因表。
// 夹具:./test-fixtures/certs(自签,gen.sh 可再生成;断言从解析结果推导,注入 now 不依赖绝对日期)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseCertChain, parseCertDate, classifyTlsError, createClusterCerts, probeConnection } from './cluster-certs.mjs'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'certs')
const read = f => readFileSync(join(FX, f), 'utf8')

test('parseCertChain:叶子证书描述符(subject 压平/SANs/指纹/daysLeft 按注入 now)', () => {
  const validTo = parseCertDate('Sep  3 10:37:21 2036 GMT')
  const now = () => validTo - 90 * 86_400_000 // 距到期整 90 天
  const chain = parseCertChain(read('leaf1.pem'), now)
  assert.equal(chain.length, 1)
  const leaf = chain[0]
  assert.match(leaf.subject, /api\.demo\.local/)
  assert.ok(!leaf.subject.includes('\n'), 'subject 应压平为单行')
  assert.ok(leaf.sans.some(s => s.includes('api.demo.local')))
  assert.ok(leaf.sans.some(s => s.includes('127.0.0.1')))
  assert.ok(!leaf.isCA)
  assert.match(leaf.fingerprint256, /^[0-9A-F:]+$/)
  assert.equal(leaf.daysLeft, 90)
  assert.ok(leaf.validFrom < leaf.validTo)
})

test('parseCertChain:CA 证书 isCA=true;多块 PEM 成链;空/坏输入返回 []', () => {
  const cas = parseCertChain(read('ca1.pem'), Date.now)
  assert.equal(cas.length, 1)
  assert.ok(cas[0].isCA)
  assert.deepEqual(parseCertChain('', Date.now), [])
  assert.deepEqual(parseCertChain('not a pem', Date.now), [])
  const both = parseCertChain(read('leaf1.pem') + read('ca1.pem'), Date.now)
  assert.equal(both.length, 2)
})

test('parseCertDate:标准格式直解;双空格/月份名兜底;垃圾返回 null', () => {
  assert.equal(parseCertDate(''), null)
  assert.equal(parseCertDate('garbage'), null)
  const ms = parseCertDate('Sep  3 10:37:21 2036 GMT') // 双空格真实形态
  assert.equal(ms, Date.UTC(2036, 8, 3, 10, 37, 21))
})

test('classifyTlsError 归因表', () => {
  assert.equal(classifyTlsError('CERT_HAS_EXPIRED'), 'cert-expired')
  assert.equal(classifyTlsError('ERR_TLS_CERT_ALTNAME_INVALID'), 'hostname-mismatch')
  for (const c of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) assert.equal(classifyTlsError(c), 'ca-mismatch', c)
  for (const c of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']) assert.equal(classifyTlsError(c), 'unreachable', c)
  assert.equal(classifyTlsError('SOMETHING_ELSE'), 'error')
  assert.equal(classifyTlsError(null), 'error')
})

// ---- 服务层 + Secret 扫描 ----
const LEAF_B64 = readFileSync(join(FX, 'leaf1.pem')).toString('base64')
// 宽拨即失败的假 socket(无 secureConnect 回调 → reachable:false 路径)
const failTls = code => () => ({
  setTimeout: () => {}, destroy: () => {},
  once: (ev, cb) => { if (ev === 'error') setImmediate(() => cb({ code, message: code })) },
})
// 宽拨+严拨都成功的假 tlsConnect 工厂(peer 链空,身份段不参与断言);与 failTls 同形:调用得 socket-fn
const okTls = () => () => ({
  setTimeout: () => {}, destroy: () => {},
  once: (ev, cb) => { if (ev === 'secureConnect') setImmediate(cb) },
  getPeerCertificate: () => ({}),
})
const now0 = () => 1_700_000_000_000

test('createClusterCerts 契约:缺 requestFn 抛错', () => {
  assert.throws(() => createClusterCerts({}), /requestFn 必传/)
})

test('getCertsReport:组装三段 + 出口无 PEM/私钥材料', async () => {
  const requestFn = async (_s, path) => {
    if (path.startsWith('/api/v1/secrets')) {
      return { body: { items: [
        { metadata: { name: 'tls-web', namespace: 'api' }, data: { 'tls.crt': LEAF_B64 } },
        { metadata: { name: 'skip', namespace: 'x' }, data: { 'tls.key': 'zzz' } }, // 无 tls.crt → 跳过
      ] } }
    }
    if (path.startsWith('/apis/cert-manager.io')) {
      return { body: { items: [{ metadata: { namespace: 'api' }, spec: { secretName: 'tls-web' }, status: { conditions: [{ type: 'Ready', status: 'True' }], renewalTime: '2026-10-01T00:00:00Z' } }] } }
    }
    throw new Error('unexpected ' + path)
  }
  const svc = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn, now: now0 })
  const r = await svc.getCertsReport({ apiServer: new URL('https://10.0.0.1:6443'), ca: read('ca1.pem'), insecure: false })
  assert.equal(r.connection.trust, 'unreachable') // 宽拨失败 ≠ 扫描段丢失
  assert.equal(r.caAnchors.length, 1)
  assert.equal(r.secrets.items.length, 1)
  const it = r.secrets.items[0]
  assert.equal(it.name, 'tls-web')
  assert.match(it.cn, /api\.demo\.local/)
  assert.equal(it.managedBy, 'cert-manager')
  assert.equal(it.certManager.ready, true)
  assert.equal(it.chainCount, 1)
  assert.ok(r.certManagerInstalled)
  assert.ok(r.fetchedAt > 0)
  const json = JSON.stringify(r)
  assert.ok(!json.includes('BEGIN CERTIFICATE'), '出口不得含 PEM')
  assert.ok(!json.includes(read('ca1.pem').split('\n')[1].slice(0, 40)), '出口不得含 CA 材料片段')
})

test('scanSecrets 降级:cert-manager 404 → 未安装;secrets 403 → forbidden 空列表', async () => {
  const requestFn = async (_s, path) => {
    if (path.startsWith('/api/v1/secrets')) {
      return { body: { items: [{ metadata: { name: 'a', namespace: 'n1' }, data: { 'tls.crt': LEAF_B64 } }, { metadata: { name: 'b', namespace: 'n2' }, data: { 'tls.crt': LEAF_B64 } }] } }
    }
    const e = new Error('not found'); e.status = 404; throw e
  }
  const svc = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn, now: now0 })
  const r = await svc.getCertsReport({ apiServer: new URL('https://x'), ca: null, insecure: true })
  assert.equal(r.secrets.error, null)
  assert.equal(r.certManagerInstalled, false)
  assert.equal(r.secrets.items.length, 2)
  assert.ok(r.secrets.items.every(i => i.managedBy === null))

  const denied = async () => { const e = new Error('forbidden'); e.status = 403; throw e }
  const svc2 = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn: denied, now: now0 })
  const r2 = await svc2.getCertsReport({ apiServer: new URL('https://x'), ca: null, insecure: true })
  assert.equal(r2.secrets.error, 'forbidden')
  assert.deepEqual(r2.secrets.items, [])
})

test('服务缓存:TTL 内复用;invalidate 清空;classifyFromRow 语义映射', async () => {
  let dials = 0
  // 两阶段 fake:第 1 拨=宽(成功,空 peer 链),第 2 拨=严(verify 失败)→ ca-mismatch
  const tlsConnect = () => { dials++; return dials === 1 ? okTls()() : failTls('UNABLE_TO_VERIFY_LEAF_SIGNATURE')() }
  // 注:okTls()/failTls(code) 返回「socket 工厂」(tlsConnect 同形),再 () 得当次 socket。
  const svc = createClusterCerts({ tlsConnect, requestFn: async () => ({ body: { items: [] } }), now: now0, ttl: 60_000 })
  const session = { apiServer: new URL('https://x'), ca: 'ca', insecure: false }
  await svc.getCertsReport(session)
  await svc.getCertsReport(session)
  assert.equal(dials, 2, '宽+严各一次;第二次调用走缓存不再拨')
  assert.ok(svc._cacheSizeForTest() >= 1)
  svc.invalidate()
  assert.equal(svc._cacheSizeForTest(), 0)
  dials = 0 // 重置相位:classifyFromRow 是一次全新探测(宽→严),fake 重新从第 1 拨走起
  assert.equal(await svc.classifyFromRow({ apiServer: 'https://x', ca: 'ca', insecure: 0 }), 'ca-mismatch')

  const okSvc = createClusterCerts({ tlsConnect: okTls(), requestFn: async () => ({ body: { items: [] } }), now: now0 })
  assert.equal(await okSvc.classifyFromRow({ apiServer: 'https://x', ca: 'ca', insecure: 0 }), 'tls-ok')
  assert.equal(await okSvc.classifyFromRow({ apiServer: 'https://x', ca: null, insecure: 1 }), 'unknown-insecure')
})

// ---- 对抗审查修复批(2026-09-06)----
test('缓存键含凭据指纹:同 origin+CA 不同 authHeader 不串缓存(防跨会话 RBAC 泄漏)', async () => {
  let calls = 0
  const requestFn = async () => { calls++; return { body: { items: [] } } }
  const svc = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn, now: now0, ttl: 60_000 })
  const a = { apiServer: new URL('https://x'), ca: 'ca', insecure: false, authHeader: 'Bearer A' }
  const b = { apiServer: new URL('https://x'), ca: 'ca', insecure: false, authHeader: 'Bearer B' }
  await svc.getCertsReport(a); await svc.getCertsReport(b)
  assert.equal(calls, 4, 'scanSecrets 按各自凭据各跑一次(secrets+cert-manager 各 1 请求)')
  await svc.getCertsReport(a)
  assert.equal(calls, 4, 'TTL 内复用各自缓存')
})

test('classifyFromRow TTL 缓存:TTL 内二次调用零拨号;K8S_INSECURE_SKIP_TLS_VERIFY 计入有效 insecure', async () => {
  let dials = 0
  const tlsConnect = () => { dials++; return dials === 1 ? okTls()() : failTls('UNABLE_TO_VERIFY_LEAF_SIGNATURE')() }
  const svc = createClusterCerts({ tlsConnect, requestFn: async () => ({ body: { items: [] } }), now: now0, ttl: 60_000 })
  const row = { apiServer: 'https://x', ca: 'ca', insecure: 0 }
  assert.equal(await svc.classifyFromRow(row), 'ca-mismatch')
  dials = 0
  assert.equal(await svc.classifyFromRow(row), 'ca-mismatch')
  assert.equal(dials, 0, 'TTL 内命中归因缓存,不再拨号')
  process.env.K8S_INSECURE_SKIP_TLS_VERIFY = 'true'
  try {
    assert.equal(await svc.classifyFromRow({ apiServer: 'https://y', ca: 'ca', insecure: 0 }), 'unknown-insecure')
  } finally { delete process.env.K8S_INSECURE_SKIP_TLS_VERIFY }
})

test('报告缓存 FIFO 封顶:防会话材质铸造撑爆单进程网关内存', async () => {
  const requestFn = async () => ({ body: { items: [] } })
  const svc = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn, now: now0 })
  for (let i = 0; i < 34; i++) await svc.getCertsReport({ apiServer: new URL(`https://x${i}`), ca: null, insecure: true })
  assert.ok(svc._cacheSizeForTest() <= 32, `缓存条目应封顶 32,实际 ${svc._cacheSizeForTest()}`)
})

test('http:// apiServer:无 TLS 语义(trust=scheme-http),零拨号', async () => {
  let dials = 0
  const r = await probeConnection(() => { dials++; throw new Error('不应拨号') }, { apiServer: 'http://x:8080', ca: 'ca', insecure: false, now: now0 })
  assert.equal(r.trust, 'scheme-http')
  assert.equal(r.reachable, true)
  assert.equal(r.peerChain.length, 0)
  assert.equal(dials, 0)
})

test('probeConnection 透传客户端证书(mTLS 前置的集群):宽/严两次拨号均带 cert/key', async () => {
  const seen = []
  const tlsConnect = opts => { seen.push(opts); return okTls()() }
  await probeConnection(tlsConnect, { apiServer: 'https://x', ca: 'ca', cert: 'CERTPEM', key: 'KEYPEM', insecure: false, now: now0 })
  assert.equal(seen.length, 2)
  assert.ok(seen.every(o => o.cert === 'CERTPEM' && o.key === 'KEYPEM'), '两次拨号都应携带客户端证书材料')
})
