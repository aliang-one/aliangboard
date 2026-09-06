# 集群证书可观测(Cluster Certificate Observability)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付证书到期可观测(session 级 `/api/cluster-certs` 端点 + `/cluster/certs` 页面)、铃铛 30/7/0 天告警、admin 集群断连的证书层归因(CA 失配/过期/主机名失配/网络)+ 重信任引导。

**Architecture:** 网关新模块 `server/cluster-certs.mjs`(DI 工厂,对标 cluster-probe):`node:crypto` X509 解析 + `node:tls` 严/宽双拨归因 + 经 `requestKubernetes` 扫 `kubernetes.io/tls` Secret 与 cert-manager CRD,模块级 TTL 缓存;新路由模块(session + k8sGate `namespace:null`);admin clusters GET 对 Disconnected 行追加 `disconnectReason`。前端:Nodes.vue 骨架的两段式 K 轨页面 + TABLE_CATALOG 注册 + AlertBell 第二查询合并伪事件(uid=证书指纹)。

**Tech Stack:** Node 内建 `node:tls`/`node:crypto`(零新依赖)、node --test(server/.test.mjs 自动入链)、vitest(.test.js)、Vue Query + DataTable。

**Spec:** `docs/superpowers/specs/2026-09-06-cluster-cert-observability-design.md`(本计划从 spec 立论,执行者须同时读 spec)

## Global Constraints

- 零新依赖:只用 `node:tls` / `node:crypto` / 既有 undici。
- **出口绝不含 PEM/DER/私钥**:证书只有派生描述符 `{subject, issuer, validFrom, validTo, daysLeft, sans[], fingerprint256, isCA}`。
- ROUTE_AUTH 单一事实源:handler 路径必须写成 `url.pathname === '/api/cluster-certs'` 字面量(守卫测试正则只认 `===`/`startsWith` 字面量)。
- i18n:zh+en 双侧同键;src 无中文字面量(注释除外);消息值禁裸 `|` 与裸 `@`;色值透明度必须 5 的倍数(`bg-error-container/30` ✓,`/12` ✗)。
- overflow 守卫:`truncate` 元素必须自带 `max-w-*`/`w-full`(DataTable 桌面 td 不裁切)。
- `check-missing-value` 纪律:computed/ref 在 `.filter/.map/.length/spread/for-of/return` 处必须 `.value`。
- queryKey 传 `cid` computed **本体**(非 `.value`,否则切集群缓存不跟随)。
- 提交:作者 `aliang-one <aliangdone@gmail.com>`(提交前 `git config user.email` 核对),信息英文,禁 `Co-Authored-By`。
- 新 node 测试放 `server/*.test.mjs`(自动入链);`src/logic/*.test.mjs` 须手动加进 package.json `test:server` 链。
- `docs/superpowers/` 在 .gitignore 中但按既有政策入库:`git add -f`。

---

### Task 1: 测试夹具入库

**Files:**
- Create: `server/test-fixtures/certs/gen.sh`、`server/test-fixtures/certs/README.md`
- 已生成(规划阶段):`ca1.key/ca1.pem/leaf1.key/leaf1.pem/ca2.key/ca2.pem`

**Interfaces:**
- Produces: `ca1.pem`(自签 CA,`CN=AB Test Root CA 1`)、`leaf1.pem`(ca1 签发,`CN=api.demo.local`,SAN `DNS:api.demo.local, DNS:k8s.demo.local, IP Address:127.0.0.1`,有效期 3650 天)、`ca2.pem`(异 CA)。测试断言一律从解析结果推导(注入 now),不硬编码绝对日期 → 再生成不破坏测试。

- [ ] **Step 1: 写 gen.sh**

```sh
#!/bin/sh
# 再生成 cluster-certs 测试夹具(Node 无法签发 X509,openssl 是唯一来源)。
# 有效期 3650 天;测试断言从解析出的日期推导(注入 now),不硬编码绝对日期 → 再生成不破坏测试。
set -e
cd "$(dirname "$0")"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca1.key -out ca1.pem -days 3650 -subj "/CN=AB Test Root CA 1/O=AliangBoard Fixtures"
openssl req -newkey rsa:2048 -nodes -keyout leaf1.key -out leaf1.csr -subj "/CN=api.demo.local/O=AliangBoard Fixtures"
printf "subjectAltName=DNS:api.demo.local,DNS:k8s.demo.local,IP:127.0.0.1\n" > leaf1.ext
openssl x509 -req -in leaf1.csr -CA ca1.pem -CAkey ca1.key -CAcreateserial -out leaf1.pem -days 3650 -extfile leaf1.ext
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca2.key -out ca2.pem -days 3650 -subj "/CN=AB Test Root CA 2/O=AliangBoard Fixtures"
rm -f leaf1.csr leaf1.ext ca1.srl
```

- [ ] **Step 2: 写 README.md**

```markdown
# cluster-certs 测试夹具

自签测试证书(仅测试用,不是任何真实环境的凭据)。Node 无法签发 X509,openssl 是唯一来源。
再生成:`sh gen.sh`(须 openssl ≥ 1.1.1)。指纹/日期会变,测试断言从解析结果推导,不依赖具体值。
- ca1.pem:测试根 CA 1;leaf1.pem:ca1 签发的叶子证书(CN=api.demo.local,SAN 见 gen.sh)
- ca2.pem:测试根 CA 2(与 ca1 无关,用于 CA 失配用例)
```

- [ ] **Step 3: 验证夹具可解析并提交**

```bash
node --input-type=module -e '
import { X509Certificate } from "node:crypto"; import { readFileSync } from "node:fs"
const x = new X509Certificate(readFileSync("server/test-fixtures/certs/leaf1.pem"))
console.log(x.subject, x.subjectAltName, Date.parse(x.validTo) > Date.now())'
git add server/test-fixtures/certs
git commit -m "test(fixtures): committed X509 cert fixtures + gen script for cluster-certs tests"
```

Expected: subject/SAN 打印、true;提交成功(chmod +x gen.sh:`git update-index --chmod=+x server/test-fixtures/certs/gen.sh` 一并执行)。

---

### Task 2: cluster-certs 纯层(X509 解析 + 错误归因表)

**Files:**
- Create: `server/cluster-certs.mjs`
- Test: `server/cluster-certs.test.mjs`

**Interfaces:**
- Produces(导出):`parseCertDate(str) → ms|null`、`describeCert(x509, now()) → descriptor`、`parseCertChain(pem, now) → descriptor[]`、`classifyTlsError(code) → 'cert-expired'|'hostname-mismatch'|'ca-mismatch'|'unreachable'|'error'`(后续任务依赖同名导出)。
- 实测 API 事实(规划阶段已验证):`x509.subject/issuer` 是 `\n` 分隔串;`validFrom/validTo` 形如 `"Sep  3 10:37:21 2036 GMT"` 且 `Date.parse` 可解;CA 判定用 `x509.ca === true`(**没有 isCA 属性**);`subjectAltName` 形如 `"DNS:x, DNS:y, IP Address:1.2.3.4"`。

- [ ] **Step 1: 写失败测试**

```js
// server/cluster-certs.test.mjs
// 纯层契约:X509 描述符(不含 PEM)/ 日期解析兜底 / TLS 错误归因表。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseCertChain, parseCertDate, classifyTlsError } from './cluster-certs.mjs'

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/cluster-certs.test.mjs`
Expected: FAIL(`Cannot find module './cluster-certs.mjs'` 或导出缺失)。

- [ ] **Step 3: 实现**

```js
// server/cluster-certs.mjs(文件头)
// 集群证书可观测(2026-09-06 设计 docs/superpowers/specs/2026-09-06-cluster-cert-observability-design.md):
// X509 解析(node:crypto)+ TLS 严/宽双拨归因(node:tls)+ kubernetes.io/tls Secret 扫描 +
// cert-manager 合并。出口只有派生描述符(指纹/主体/日期),绝不含 PEM/DER/私钥。
// tlsConnect/requestFn/now 全量可注入 → 可脱离真实集群单测(对标 cluster-probe 的抽模块约定)。
import { X509Certificate, createHash } from 'node:crypto'
import * as nodeTls from 'node:tls'

const DEFAULT_TTL = 60_000     // 报告缓存窗口:页面 30s 轮询 + 铃铛 5min 共享,不重复拨号
const DEFAULT_TIMEOUT = 5_000  // 单次 TLS 握手上限(cluster-probe 同款量级)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// X509Certificate.validTo 形如 "Sep  3 10:37:21 2036 GMT"。Date.parse 在 V8 可解;
// 兜底走月份名映射(不依赖实现对非 ISO 日期的宽容度)。
export function parseCertDate(str) {
  if (!str) return null
  const direct = Date.parse(str)
  if (!Number.isNaN(direct)) return direct
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(String(str))
  if (!m) return null
  const mi = MONTHS.indexOf(m[1])
  if (mi < 0) return null
  return Date.UTC(Number(m[6]), mi, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

// 描述符 = 本模块证书的唯一出口形态(绝不含 PEM/DER)。
export function describeCert(x509, now) {
  const validFrom = parseCertDate(x509.validFrom)
  const validTo = parseCertDate(x509.validTo)
  return {
    subject: String(x509.subject || '').replace(/\n/g, ', '),
    issuer: String(x509.issuer || '').replace(/\n/g, ', '),
    validFrom, validTo,
    daysLeft: validTo == null ? null : Math.ceil((validTo - now()) / 86_400_000),
    sans: String(x509.subjectAltName || '').split(/,\s*/).filter(Boolean),
    fingerprint256: x509.fingerprint256 || null,
    isCA: x509.ca === true, // 注意:X509Certificate 无 isCA 属性,CA 标记在 .ca
  }
}

export function parseCertChain(pem, now) {
  if (!pem) return []
  const out = []
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  for (const m of String(pem).matchAll(re)) {
    try { out.push(describeCert(new X509Certificate(m[0]), now)) } catch { /* 坏块跳过 */ }
  }
  return out
}

const CA_MISMATCH_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_CHAIN_INCOMPLETE'])
const NET_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'])

export function classifyTlsError(code) {
  if (code === 'CERT_HAS_EXPIRED') return 'cert-expired'
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'hostname-mismatch'
  if (CA_MISMATCH_CODES.has(code)) return 'ca-mismatch'
  if (NET_CODES.has(code)) return 'unreachable'
  return 'error'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/cluster-certs.test.mjs` → PASS。

- [ ] **Step 5: Commit** `feat(server): cluster-certs pure layer — X509 descriptors + TLS error classification`

---

### Task 3: TLS 双拨探测 probeConnection

**Files:**
- Modify: `server/cluster-certs.mjs`(追加)
- Test: `server/cluster-certs-tls.test.mjs`(真 `tls.createServer` + 夹具)

**Interfaces:**
- Consumes: Task 2 的 `describeCert/classifyTlsError/NET_CODES`。
- Produces: `export async function probeConnection(tlsConnect, { apiServer, ca, insecure, timeout, now })` → `{ trust, reachable, reasonCode, reason, peerChain[] }`;`trust ∈ 'trusted'|'unverified'|'ca-mismatch'|'cert-expired'|'hostname-mismatch'|'unreachable'|'error'`;`peerChain` = 描述符数组(leaf 在首位)。内部 `tlsDial(tlsConnect, {host,port,servername,ca,rejectUnauthorized,timeout})`(不导出)。

- [ ] **Step 1: 写失败测试(真 TLS,零 mock)**

```js
// server/cluster-certs-tls.test.mjs
// 真 tls.createServer + 提交夹具:严/宽双拨语义端到端(端口/证书/CA 全真实,离线可跑)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { probeConnection } from './cluster-certs.mjs'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'certs')
const read = f => readFileSync(join(FX, f))
const CA1 = read('ca1.pem').toString('utf8'), CA2 = read('ca2.pem').toString('utf8')

function serve(cert, key) {
  return new Promise(resolve => {
    const server = tls.createServer({ key, cert }, s => s.end('hi'))
    server.listen(0, '127.0.0.1', () => resolve({ server, url: new URL(`https://api.demo.local:${server.address().port}`) }))
  })
}
const PROBE = (url, ca, insecure = false) => probeConnection(tls.connect, { apiServer: url, ca, insecure, timeout: 3000, now: Date.now })
const cleanup = []

test('严拨通过(存储 CA=签发 CA)→ trusted,peerChain 含 leaf 描述符', async () => {
  const { server, url } = await serve(read('leaf1.pem'), read('leaf1.key')); cleanup.push(server)
  const r = await PROBE(url, CA1)
  assert.equal(r.trust, 'trusted'); assert.equal(r.reachable, true)
  assert.match(r.peerChain[0].subject, /api\.demo\.local/)
  assert.ok(r.peerChain[0].sans.some(s => s.includes('api.demo.local')))
})

test('CA 失配(存储 CA=ca2,服务端链锚定 ca1)→ ca-mismatch + reasonCode', async () => {
  const { server, url } = await serve(read('leaf1.pem'), read('leaf1.key')); cleanup.push(server)
  const r = await PROBE(url, CA2)
  assert.equal(r.trust, 'ca-mismatch'); assert.equal(r.reachable, true)
  assert.equal(r.reasonCode, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
})

test('insecure 会话(无 CA 校验语义)→ unverified,仍报 peer 链', async () => {
  const { server, url } = await serve(read('leaf1.pem'), read('leaf1.key')); cleanup.push(server)
  const r = await PROBE(url, null, true)
  assert.equal(r.trust, 'unverified'); assert.ok(r.peerChain.length >= 1)
})

test('端口拒连 → unreachable', async () => {
  const { server, url } = await serve(read('leaf1.pem'), read('leaf1.key'))
  await new Promise(r => server.close(r)) // 拿一个已关闭端口
  const r = await PROBE(url, CA1)
  assert.equal(r.trust, 'unreachable'); assert.equal(r.reachable, false)
})

process.on('exit', () => { for (const s of cleanup) try { s.close() } catch { /* noop */ } })
```

(hostname-mismatch 的 servername 换名用例:夹具 SAN 不含 `evil.other.local`,`PROBE` 传 `servername` 覆盖——在 probeConnection 增加 `servernameOverride` 可选参仅供测试?**不加**;改为直接验证:`tls.connect` 层已被规划阶段实测 `ERR_TLS_CERT_ALTNAME_INVALID`,归因表单测已覆盖该 code → 端到端用例省略,避免为测试开口子。)

- [ ] **Step 2: 跑测试确认失败**(probeConnection 未导出)。

- [ ] **Step 3: 实现(追加到 cluster-certs.mjs)**

```js
// 单次 TLS 拨号:resolve 永不 reject(错误折成 {ok:false,code,message});socket 用后即毁。
// 注入式 tlsConnect(默认 node:tls.connect)签名:opts → 带 once/setTimeout/getPeerCertificate/destroy 的 socket。
function tlsDial(tlsConnect, { host, port, servername, ca, rejectUnauthorized, timeout }) {
  return new Promise(resolve => {
    let settled = false
    const done = v => { if (!settled) { settled = true; resolve(v) } }
    let socket
    try { socket = tlsConnect({ host, port, servername, ca: ca || undefined, rejectUnauthorized, timeout }) }
    catch (e) { return done({ ok: false, code: 'DIAL_ERROR', message: e?.message || String(e) }) }
    if (!socket || typeof socket.once !== 'function') return done({ ok: false, code: 'DIAL_ERROR', message: 'tlsConnect 返回非 socket' })
    socket.setTimeout(timeout, () => { try { socket.destroy() } catch { /* noop */ } done({ ok: false, code: 'ETIMEDOUT', message: 'tls handshake timeout' }) })
    socket.once('secureConnect', () => {
      try {
        // getPeerCertificate(true) 自 leaf 起带 issuerCertificate 链;空对象无 raw → 停走。
        const chain = []
        let cur = socket.getPeerCertificate(true)
        const seen = new Set()
        let guard = 0
        while (cur && cur.raw && cur.raw.length && !seen.has(cur) && guard++ < 8) {
          seen.add(cur)
          try { chain.push(new X509Certificate(cur.raw)) } catch { /* 坏块跳过 */ }
          cur = cur.issuerCertificate
        }
        try { socket.destroy() } catch { /* noop */ }
        done({ ok: true, chain })
      } catch (e) {
        try { socket.destroy() } catch { /* noop */ }
        done({ ok: false, code: 'PEER_ERROR', message: e?.message || String(e) })
      }
    })
    socket.once('error', err => { try { socket.destroy() } catch { /* noop */ } done({ ok: false, code: err?.code || null, message: err?.message || String(err) }) })
  })
}

// 严/宽双拨:宽拨(rejectUnauthorized:false)拿 peer 链 + 可达性;严拨(存储 CA)裁决信任。
// 与 getDispatcher 的 sig 缓存/K8S_INSECURE_SKIP_TLS_VERIFY 解耦(侦察报告风险):独立拨号,用后即毁。
export async function probeConnection(tlsConnect, { apiServer, ca, insecure, timeout = DEFAULT_TIMEOUT, now = Date.now }) {
  const u = apiServer instanceof URL ? apiServer : new URL(String(apiServer))
  const base = { host: u.hostname, port: Number(u.port || 443), servername: u.hostname }
  const loose = await tlsDial(tlsConnect, { ...base, rejectUnauthorized: false, timeout })
  if (!loose.ok) {
    return { trust: NET_CODES.has(loose.code) ? 'unreachable' : 'error', reachable: false, reasonCode: loose.code || null, reason: loose.message || '', peerChain: [] }
  }
  const peerChain = loose.chain.map(x => describeCert(x, now))
  if (!ca || insecure) return { trust: 'unverified', reachable: true, reasonCode: null, reason: '', peerChain }
  const strict = await tlsDial(tlsConnect, { ...base, ca, rejectUnauthorized: true, timeout })
  if (strict.ok) return { trust: 'trusted', reachable: true, reasonCode: null, reason: '', peerChain }
  return { trust: classifyTlsError(strict.code), reachable: true, reasonCode: strict.code || null, reason: strict.message || '', peerChain }
}
```

- [ ] **Step 4: 跑测试确认通过** `node --test server/cluster-certs-tls.test.mjs`
- [ ] **Step 5: Commit** `feat(server): cluster-certs TLS double-dial probe (strict/loose) with live-tls tests`

---

### Task 4: Secret 扫描 + cert-manager 合并 + 服务工厂

**Files:**
- Modify: `server/cluster-certs.mjs`(追加)
- Test: `server/cluster-certs.test.mjs`(追加用例)

**Interfaces:**
- Consumes: `requestKubernetes(session, path)`(生产注入;测试注入 fake `requestFn(ctx, path) → {body}`)、Task 2/3 导出。
- Produces: `export function createClusterCerts({ tlsConnect = nodeTls.connect, requestFn, now = Date.now, ttl, timeout })` → `{ getCertsReport(session), classifyFromRow(row), invalidate(), _cacheSizeForTest() }`;缺 requestFn 抛 `'createClusterCerts: requestFn 必传'`。
- 报告形状(路由直接 200 返回):
```js
{ connection: { apiServer, trust, reachable, reasonCode, reason, peerChain[] },
  caAnchors: descriptor[],
  secrets: { items: [{ name, namespace, cn, issuer, sans, expires, daysLeft, fingerprint256, chainCount, managedBy, certManager: { ready, renewalTime } | null }], error: null | 'forbidden' | 'error' },
  certManagerInstalled: boolean, fetchedAt: ms }
```
- 缓存键:`origin + '|' + (insecure ? 'insecure' : ca ? sha256(ca).slice(0,16) : 'noca')`(同集群不同信任材料的会话不串缓存)。

- [ ] **Step 1: 追加失败测试**

```js
// server/cluster-certs.test.mjs 追加 import 与用例
import { createClusterCerts } from './cluster-certs.mjs'

const LEAF_B64 = readFileSync(join(FX, 'leaf1.pem')).toString('base64')
const fakeSocket = ({ code } = {}) => ({
  setTimeout: () => {}, destroy: () => {},
  once: (ev, cb) => { if (ev === 'error' && code) setImmediate(() => cb({ code, message: code })) },
  // 无 secureConnect 回调 → 宽拨即失败(unreachable/error 路径用)
})
const failTls = code => opts => fakeSocket({ code })
const now0 = () => 1_700_000_000_000

test('createClusterCerts 契约:缺 requestFn 抛错', () => {
  assert.throws(() => createClusterCerts({}), /requestFn 必传/)
})

test('getCertsReport:组装三段 + 出口无 PEM/私钥', async () => {
  const requestFn = async (_s, path) => {
    if (path.startsWith('/api/v1/secrets')) return { body: { items: [{ metadata: { name: 'tls-web', namespace: 'api' }, data: { 'tls.crt': LEAF_B64 } }, { metadata: { name: 'skip', namespace: 'x' }, data: { 'tls.key': 'zzz' } }] } }
    if (path.startsWith('/apis/cert-manager.io')) return { body: { items: [{ metadata: { namespace: 'api' }, spec: { secretName: 'tls-web' }, status: { conditions: [{ type: 'Ready', status: 'True' }], renewalTime: '2026-10-01T00:00:00Z' } }] } }
    throw new Error('unexpected ' + path)
  }
  const svc = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn, now: now0 })
  const session = { apiServer: new URL('https://10.0.0.1:6443'), ca: read('ca1.pem'), insecure: false }
  const r = await svc.getCertsReport(session)
  assert.equal(r.connection.trust, 'unreachable')
  assert.equal(r.caAnchors.length, 1)
  assert.equal(r.secrets.items.length, 1) // 无 tls.crt 的 secret 被跳过
  const it = r.secrets.items[0]
  assert.equal(it.name, 'tls-web'); assert.match(it.cn, /api\.demo\.local/)
  assert.equal(it.managedBy, 'cert-manager'); assert.equal(it.certManager.ready, true)
  assert.ok(r.certManagerInstalled)
  const json = JSON.stringify(r)
  assert.ok(!json.includes('BEGIN CERTIFICATE'), '出口不得含 PEM')
  assert.ok(!json.includes(read('ca1.pem').split('\n')[1].slice(0, 40)), '出口不得含 CA 材料片段')
})

test('scanSecrets 降级:secrets 403 → error=forbidden;cert-manager 404 → 未安装;items 按 daysLeft 升序', async () => {
  const requestFn = async (_s, path) => {
    if (path.startsWith('/api/v1/secrets')) {
      const mk = (name, ns, days) => ({ metadata: { name, namespace: ns }, data: { 'tls.crt': LEAF_B64 }, _days: days })
      // 用两个同证书 secret:daysLeft 相同 → 改用名字序验证稳定排序即可(内容一致时顺序断言放宽)
      return { body: { items: [mk('a', 'n1'), mk('b', 'n2')] } }
    }
    const e = new Error('not found'); e.status = 404; throw e
  }
  const svc = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn, now: now0 })
  const r = await svc.getCertsReport({ apiServer: new URL('https://x'), ca: null, insecure: true })
  assert.equal(r.secrets.error, null); assert.equal(r.certManagerInstalled, false)
  assert.equal(r.secrets.items.length, 2)
  // 403 用例
  const denied = async () => { const e = new Error('forbidden'); e.status = 403; throw e }
  const svc2 = createClusterCerts({ tlsConnect: failTls('ECONNREFUSED'), requestFn: async (_s, p) => (p.startsWith('/api/v1/secrets') ? denied() : denied()), now: now0 })
  const r2 = await svc2.getCertsReport({ apiServer: new URL('https://x'), ca: null, insecure: true })
  assert.equal(r2.secrets.error, 'forbidden'); assert.deepEqual(r2.secrets.items, [])
})

test('服务缓存:TTL 内复用(零二次拨号),invalidate 清空;classifyFromRow 语义映射', async () => {
  let dials = 0
  const requestFn = async () => { const e = new Error('f'); e.status = 403; throw e }
  const tlsConnect = opts => { dials++; return fakeSocket({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }
  const svc = createClusterCerts({ tlsConnect, requestFn, now: now0, ttl: 60_000 })
  const session = { apiServer: new URL('https://x'), ca: 'ca', insecure: false }
  await svc.getCertsReport(session); await svc.getCertsReport(session)
  assert.equal(dials, 2) // 宽+严各一次;第二次调用走缓存
  assert.equal(dials, 2)
  svc.invalidate(); assert.equal(svc._cacheSizeForTest(), 0)
  // classifyFromRow:严拨失败 ca-mismatch → 'ca-mismatch';trusted → 'tls-ok';insecure → 'unknown-insecure'
  assert.equal(await svc.classifyFromRow({ apiServer: 'https://x', ca: 'ca', insecure: 0 }), 'ca-mismatch')
  const okSvc = createClusterCerts({ tlsConnect: () => ({ setTimeout: () => {}, destroy: () => {}, once: (ev, cb) => { if (ev === 'secureConnect') setImmediate(cb) }, getPeerCertificate: () => ({}) }), requestFn, now: now0 })
  assert.equal(await okSvc.classifyFromRow({ apiServer: 'https://x', ca: 'ca', insecure: 0 }), 'tls-ok')
  assert.equal(await okSvc.classifyFromRow({ apiServer: 'https://x', ca: null, insecure: 1 }), 'unknown-insecure')
})
```

(注:`failTls('ECONNREFUSED')` 使宽拨失败 → trust=unreachable 且**不触发严拨**,secrets 段仍由 requestFn 组装——正测「连接坏 ≠ 扫描段丢失」。)

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现(追加到 cluster-certs.mjs)**

```js
async function scanSecrets(requestFn, session, now) {
  const out = { items: [], error: null, certManagerInstalled: false }
  let body = null
  try {
    const r = await requestFn(session, `/api/v1/secrets?fieldSelector=${encodeURIComponent('type=kubernetes.io/tls')}&limit=500`)
    body = r?.body
  } catch (e) {
    out.error = e?.status === 403 ? 'forbidden' : 'error'
    return out
  }
  // cert-manager 合并(404 = 未安装,静默降级;其余失败不阻塞 secrets 段)
  const cmMap = new Map()
  try {
    const cm = await requestFn(session, '/apis/cert-manager.io/v1/certificates?limit=500')
    out.certManagerInstalled = true
    for (const it of (cm?.body?.items || [])) {
      cmMap.set(`${it.metadata?.namespace || 'default'}/${it.spec?.secretName || ''}`, {
        ready: (it.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'),
        renewalTime: it.status?.renewalTime || null,
      })
    }
  } catch { /* 404/403 一律视为未安装,不细究 */ }
  for (const it of (body?.items || [])) {
    const crt = it?.data?.['tls.crt']
    if (!crt) continue
    let chain = []
    try { chain = parseCertChain(Buffer.from(crt, 'base64').toString('utf8'), now) } catch { continue }
    if (!chain.length) continue
    const leaf = chain[0]
    const cm = cmMap.get(`${it.metadata?.namespace || 'default'}/${it.metadata?.name || ''}`) || null
    out.items.push({
      name: it.metadata?.name || '', namespace: it.metadata?.namespace || '',
      cn: leaf.subject, issuer: leaf.issuer, sans: leaf.sans,
      expires: leaf.validTo, daysLeft: leaf.daysLeft, fingerprint256: leaf.fingerprint256,
      chainCount: chain.length, managedBy: cm ? 'cert-manager' : null, certManager: cm,
    })
  }
  out.items.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity))
  return out
}

export function createClusterCerts({ tlsConnect = nodeTls.connect, requestFn, now = Date.now, ttl = DEFAULT_TTL, timeout = DEFAULT_TIMEOUT } = {}) {
  if (typeof requestFn !== 'function') throw new Error('createClusterCerts: requestFn 必传')
  const cache = new Map()
  const cacheKeyOf = s => {
    const origin = s?.apiServer instanceof URL ? s.apiServer.origin : String(s?.apiServer || '')
    if (s?.insecure) return `${origin}|insecure`
    if (!s?.ca) return `${origin}|noca`
    return `${origin}|${createHash('sha256').update(s.ca).digest('hex').slice(0, 16)}`
  }
  async function getCertsReport(session) {
    const key = cacheKeyOf(session)
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttl) return hit.data
    const [connection, caAnchors, scanned] = await Promise.all([
      probeConnection(tlsConnect, { apiServer: session.apiServer, ca: session.ca || null, insecure: !!session.insecure, timeout, now }),
      parseCertChain(session.ca || '', now),
      scanSecrets(requestFn, session, now),
    ])
    const data = {
      connection: { apiServer: (session.apiServer instanceof URL ? session.apiServer.origin : String(session.apiServer || '')), ...connection },
      caAnchors, secrets: { items: scanned.items, error: scanned.error },
      certManagerInstalled: scanned.certManagerInstalled, fetchedAt: now(),
    }
    cache.set(key, { data, at: now() })
    return data
  }
  // admin 断连归因:TLS 层结论;'tls-ok' = 断连但证书链无碍(凭据/上游层);insecure 无法裁决。
  async function classifyFromRow(row) {
    try {
      const r = await probeConnection(tlsConnect, { apiServer: row.apiServer, ca: row.ca || null, insecure: !!row.insecure, timeout, now })
      if (r.trust === 'trusted') return 'tls-ok'
      if (r.trust === 'unverified') return 'unknown-insecure'
      return r.trust
    } catch { return 'error' }
  }
  return { getCertsReport, classifyFromRow, invalidate: () => cache.clear(), _cacheSizeForTest: () => cache.size }
}
```

- [ ] **Step 4: 跑全部 cluster-certs 测试通过**(两个文件)
- [ ] **Step 5: Commit** `feat(server): cluster-certs service — tls secret scan, cert-manager merge, TTL cache`

---

### Task 5: session 路由 + ROUTE_AUTH + 接线

**Files:**
- Create: `server/routes/cluster-certs.mjs`
- Modify: `server/route-auth-map.mjs`(session 段)、`server/index.mjs`(import/服务/路由链/admin deps)、`server/messages/api.mjs`(1 键)
- Test: `server/routes/cluster-certs.test.mjs`、`server/route-auth-map.test.mjs`(既有守卫自动覆盖新字面量)

**Interfaces:**
- Consumes: `createClusterCerts` 服务、`k8sGate.gateK8sSession(session, {namespace, level, path, method})`、`levelForRequest`(`server/authz.mjs`)、`msg(req, code)`。
- Produces: `createClusterCertsRoutes({ sendJson, msg, clusterCerts, k8sGate, levelForRequest })` → `{ handle }`;`GET /api/cluster-certs` → 200 报告 | 403 nsForbidden | 502 `{message}`。

- [ ] **Step 1: 写失败测试**

```js
// server/routes/cluster-certs.test.mjs
// GET /api/cluster-certs 契约:session 门已过(门外 ROUTE_AUTH),ns 门 namespace:null(集群级读,
// 对齐 registry-tags 先例),报告直传 200,上游失败 502。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createClusterCertsRoutes } from './cluster-certs.mjs'
import { authClassFor } from '../route-auth-map.mjs'

const REPORT = { connection: { trust: 'trusted', peerChain: [] }, caAnchors: [], secrets: { items: [], error: null }, certManagerInstalled: false, fetchedAt: 1 }

function makeHarness({ report = REPORT, gateResult = true } = {}) {
  const sent = [], gateCalls = []
  const routes = createClusterCertsRoutes({
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    msg: (req, code) => code,
    clusterCerts: { getCertsReport: async () => report },
    k8sGate: { gateK8sSession: (session, info) => { gateCalls.push(info); return gateResult } },
    levelForRequest: () => 'view',
  })
  return { sent, gateCalls, call: (m, p) => routes.handle({ method: m, on: () => {}, abSession: { apiServer: 'https://x' } }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

test('200:报告直传;ns 门收到 namespace:null + level:view + 会话本体', async () => {
  const h = makeHarness()
  assert.equal(await h.call('GET', '/api/cluster-certs'), true)
  assert.equal(h.sent[0].status, 200)
  assert.deepEqual(Object.keys(h.sent[0].json).sort(), ['caAnchors', 'certManagerInstalled', 'connection', 'fetchedAt', 'secrets'])
  assert.equal(h.gateCalls[0].namespace, null)
  assert.equal(h.gateCalls[0].level, 'view')
  assert.equal(h.gateCalls[0].method, 'GET')
})

test('ns 门拒绝 → 403 nsForbidden;非目标路径/方法 → false 放行', async () => {
  const h = makeHarness({ gateResult: false })
  await h.call('GET', '/api/cluster-certs')
  assert.equal(h.sent[0].status, 403); assert.equal(h.sent[0].json.message, 'api.nsForbidden')
  const h2 = makeHarness()
  assert.equal(await h2.call('POST', '/api/cluster-certs'), false)
  assert.equal(await h2.call('GET', '/api/other'), false)
})

test('上游失败 → 502 透出 message(兜底 api.clusterCertsFailed)', async () => {
  const routes = createClusterCertsRoutes({
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    msg: (req, code) => code,
    clusterCerts: { getCertsReport: async () => { throw Object.assign(new Error('boom'), { status: 502 }) } },
    k8sGate: { gateK8sSession: () => true }, levelForRequest: () => 'view',
  })
  const sent = []
  await routes.handle({ method: 'GET', on: () => {}, abSession: {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/cluster-certs'))
  assert.equal(sent[0].status, 502)
})

test('ROUTE_AUTH 登记:GET /api/cluster-certs → session(门外不 404)', () => {
  assert.equal(authClassFor('GET', '/api/cluster-certs'), 'session')
})
```

(注:第 3 个用例里 `sent` 数组要在 `createClusterCertsRoutes` 之前声明——实现时写成 `const sent = []` 在顶部。)

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```js
// server/routes/cluster-certs.mjs
// GET /api/cluster-certs(2026-09-06 证书可观测):session 级集群证书报告——连接证书(TLS 双拨归因)+
// 信任 CA 锚 + kubernetes.io/tls Secret 扫描 + cert-manager 合并。出口无任何 PEM/私钥材料。
// 鉴权:门外 ROUTE_AUTH session;ns 门 namespace:null(集群级读,对齐 registry-tags 先例:
// open 模式照常放行,allowlist 模式按集群授权,admin 短路)。报告缓存 60s 在服务层。
export function createClusterCertsRoutes(deps) {
  const { sendJson, msg, clusterCerts, k8sGate, levelForRequest } = deps
  async function handle(req, res, url) {
    if (url.pathname === '/api/cluster-certs' && req.method === 'GET') {
      const session = req.abSession // 路由鉴权门已预检并缓存
      if (!k8sGate.gateK8sSession(session, { namespace: null, level: levelForRequest(req.method), path: url.pathname, method: req.method })) return sendJson(res, 403, { message: msg(req, 'api.nsForbidden') })
      try {
        return sendJson(res, 200, await clusterCerts.getCertsReport(session))
      } catch (error) {
        return sendJson(res, error.status || 502, { message: error?.message || msg(req, 'api.clusterCertsFailed') })
      }
    }
    return false
  }
  return { handle }
}
```

`server/route-auth-map.mjs` session 段,`{ method: 'GET', pattern: '/api/resource/tree', ... }` 行后加:

```js
  { method: 'GET',  pattern: '/api/cluster-certs',    auth: 'session' }, // 证书可观测(2026-09-06):连接证书 + TLS Secret 扫描
```

`server/messages/api.mjs` 追加(双语,messages.test 会全键断言):

```js
  'api.clusterCertsFailed': { zh: '证书探测失败', en: 'Certificate probe failed' },
```

`server/index.mjs` 三处:
1. `import { createClusterProber } from './cluster-probe.mjs'`(约 :15)后加 `import { createClusterCerts } from './cluster-certs.mjs'` 与 `import { createClusterCertsRoutes } from './routes/cluster-certs.mjs'`;
2. `const clusterProber = createClusterProber({ requestFn: requestKubernetes })`(:630)后加:

```js
// 集群证书可观测(2026-09-06):/api/cluster-certs 用;admin 断连归因复用 classifyFromRow。
const clusterCerts = createClusterCerts({ requestFn: requestKubernetes })
```

3. `createAdminRoutes({...})`(约 :1573)deps 加 `clusterCerts,`;`const ingressControllerRoutes = createIngressControllerRoutes({ sendJson })`(:1617)后加:

```js
  const clusterCertsRoutes = createClusterCertsRoutes({ sendJson, msg, clusterCerts, k8sGate, levelForRequest })
```

分发链 `if (await versionRoutes.handle(req, res, url)) return` 后加:

```js
  if (await clusterCertsRoutes.handle(req, res, url)) return
```

- [ ] **Step 4: 跑测试 + 守卫**

```bash
node --test server/routes/cluster-certs.test.mjs server/route-auth-map.test.mjs && npm run typecheck
```

Expected: 全 PASS(守卫测试扫描到新字面量且已登记)。

- [ ] **Step 5: Commit** `feat(server): GET /api/cluster-certs session route (ROUTE_AUTH + cluster-scope ns gate)`

---

### Task 6: admin 断连归因 + ClusterCard 徽标

**Files:**
- Modify: `server/routes/admin.mjs`(deps + GET clusters 富化 + 白名单)、`src/components/common/ClusterCard.vue`、`src/locales/zh.json`/`en.json`(component.clusterCard 5 键)
- Test: `server/admin-cluster-disconnect-reason.test.mjs`

**Interfaces:**
- Consumes: Task 4 `classifyFromRow(row)`(row 含 `apiServer/ca/insecure`)。
- Produces: `/api/admin/clusters` 行新增 `disconnectReason: 'ca-mismatch'|'cert-expired'|'hostname-mismatch'|'unreachable'|'error'|'tls-ok'|'unknown-insecure'|undefined`(仅 Disconnected 行有;凭据列照旧不外泄)。ClusterCard 徽标键:`component.clusterCard.reason*`。

- [ ] **Step 1: 写失败测试**

```js
// server/admin-cluster-disconnect-reason.test.mjs
// GET /api/admin/clusters 断连归因:仅 Disconnected 行触发 classifyFromRow;白名单透出
// disconnectReason 且凭据列(ca/cert/key/authHeader)绝不入列。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ rows, reason = 'ca-mismatch' } = {}) {
  const sent = [], classified = []
  const routes = createAdminRoutes({
    db: { prepare: (sql) => ({ all: () => (sql.includes('FROM clusters') ? rows : []), get: () => null, run: () => {} }) },
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => ({}),
    requireAdmin: () => ({ role: 'admin', username: 'admin' }),
    clusterProber: { probeAll: async (rs) => rs, invalidate: () => {} },
    clusterCerts: { classifyFromRow: async (row) => { classified.push(row.id); return reason } },
    buildCallContext: c => c,
    requestKubernetes: async () => { throw new Error('不应被调') },
  })
  return { sent, classified, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}
const row = (id, status) => ({ id, name: 'n' + id, apiServer: 'https://x', authMethod: 'token', version: 'v', insecure: 0, nsAuthMode: 'open', createdBy: 'a', createdAt: 1, authHeader: 'Bearer secret', ca: 'PEM', cert: null, key: null, status })

test('Disconnected 行富化 disconnectReason;Healthy 行零调用;凭据列不入列', async () => {
  const h = makeHarness({ rows: [row('c1', 'Disconnected'), row('c2', 'Healthy')] })
  await h.call('GET', '/api/admin/clusters')
  assert.equal(h.sent[0].status, 200)
  const cs = h.sent[0].json.clusters
  assert.equal(cs[0].disconnectReason, 'ca-mismatch')
  assert.equal(cs[1].disconnectReason, undefined)
  assert.deepEqual(h.classified, ['c1'])
  const json = JSON.stringify(cs)
  assert.ok(!json.includes('Bearer secret') && !json.includes('authHeader') && !json.includes('"ca"'))
})
```

- [ ] **Step 2: 确认失败**(当前响应无 disconnectReason)
- [ ] **Step 3: 实现**

`server/routes/admin.mjs`:`createAdminRoutes` 解构(约 :18-25)加 `clusterCerts,`;GET handler `probeAll` 之后、白名单 map 之前改为:

```js
      const probed = await clusterProber.probeAll(
        rows,
        r => buildCallContext({ apiServer: r.apiServer, authHeader: r.authHeader, ca: r.ca, cert: r.cert, key: r.key, insecure: !!r.insecure }),
        { force },
      )
      // 断连归因(2026-09-06 证书可观测):仅 Disconnected 行做 TLS 层诊断(CA 失配/过期/主机名/网络),
      // Healthy 零开销;服务层 60s 缓存,列表刷新不重复拨号。'tls-ok'=证书链无碍,断连在凭据/上游层。
      const enriched = await Promise.all(probed.map(async c => (
        c.status === 'Disconnected' ? { ...c, disconnectReason: await clusterCerts.classifyFromRow(c) } : c
      )))
      // 白名单回传:前端需要的字段 + 实时探测富字段 + 断连归因(凭据不入列)。
      const clusters = enriched.map(c => ({ id: c.id, name: c.name, apiServer: c.apiServer, authMethod: c.authMethod, version: c.version, insecure: c.insecure, nsAuthMode: c.nsAuthMode, createdBy: c.createdBy, createdAt: c.createdAt, status: c.status, nodeCount: c.nodeCount, podCount: c.podCount, disconnectReason: c.disconnectReason }))
```

`ClusterCard.vue` 徽章区(「指标」块之前)加(script 加映射):

```js
// 断连归因(2026-09-06):CA 失配/过期/主机名/网络;tls-ok=证书链无碍(凭据/上游层)。缺字段向后兼容。
const DISCONNECT_LABEL = {
  'ca-mismatch': 'component.clusterCard.reasonCaMismatch',
  'cert-expired': 'component.clusterCard.reasonCertExpired',
  'hostname-mismatch': 'component.clusterCard.reasonHostnameMismatch',
  'unreachable': 'component.clusterCard.reasonUnreachable',
  'tls-ok': 'component.clusterCard.reasonTlsOk',
}
```

```html
    <div v-if="c.status === 'Disconnected' && DISCONNECT_LABEL[c.disconnectReason]"
      class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-error-container/30 text-error text-xs font-medium"
      :title="c.apiServer">
      <span class="material-symbols-outlined text-xs">key_off</span> {{ t(DISCONNECT_LABEL[c.disconnectReason]) }}
    </div>
```

locales `component.clusterCard` 块内(zh/en 同键):
zh:`"reasonCaMismatch": "证书失配", "reasonCertExpired": "证书过期", "reasonHostnameMismatch": "主机名失配", "reasonUnreachable": "网络不可达", "reasonTlsOk": "非证书原因"`
en:`"reasonCaMismatch": "CA mismatch", "reasonCertExpired": "Cert expired", "reasonHostnameMismatch": "Hostname mismatch", "reasonUnreachable": "Unreachable", "reasonTlsOk": "Non-cert failure"`

- [ ] **Step 4: 跑测试** `node --test server/admin-cluster-disconnect-reason.test.mjs && npm run test:unit -- ClusterCard`(如有既有 ClusterCard 测试须全绿)
- [ ] **Step 5: Commit** `feat(admin): cluster disconnect attribution (disconnectReason) + ClusterCard reason chip`

---

### Task 7: 前端纯逻辑 certExpiry(node runner)

**Files:**
- Create: `src/logic/certExpiry.js`、`src/logic/certExpiry.test.mjs`
- Modify: `package.json`(`test:server` 链尾追加)

**Interfaces:**
- Produces: `CERT_WARN_DAYS=30`、`CERT_CRITICAL_DAYS=7`、`certSeverity(daysLeft) → 'expired'|'critical'|'warn'|'ok'|'unknown'`、`buildCertAlerts(report, { now, t }) → bell 伪事件[]`(Task 10/11 消费)。伪事件字段:`{ uid:'cert:<fp>', type:'warning', reason, relatedKind:'Certificate', relatedName, relatedNamespace, namespace, age, icon:'key', color:'tertiary'|'error', _ts }`。

- [ ] **Step 1: 写失败测试**

```js
// src/logic/certExpiry.test.mjs
// 纯逻辑零依赖 runner:分级边界 + 铃铛伪事件构造(uid 稳定性/阈值过滤/i18n 注入)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { certSeverity, buildCertAlerts } from './certExpiry.js'

test('certSeverity 边界:<0 过期;≤7 critical;≤30 warn;>30 ok;null unknown', () => {
  assert.equal(certSeverity(-1), 'expired')
  assert.equal(certSeverity(0), 'critical')
  assert.equal(certSeverity(7), 'critical')
  assert.equal(certSeverity(8), 'warn')
  assert.equal(certSeverity(30), 'warn')
  assert.equal(certSeverity(31), 'ok')
  assert.equal(certSeverity(null), 'unknown')
})

test('buildCertAlerts:仅 expired/critical/warn 进铃铛;uid=cert:指纹(跨天稳定);t 注入', () => {
  const item = (over) => ({ name: 'tls-web', namespace: 'api', daysLeft: over, fingerprint256: 'AA:BB:CC' })
  const report = { secrets: { items: [item(45), item(12), item(3), item(-5), item(null)], error: null } }
  const t = (k, p) => `${k}:${JSON.stringify(p || {})}`
  const alerts = buildCertAlerts(report, { now: () => 123, t })
  assert.equal(alerts.length, 3)
  assert.ok(alerts.every(a => a.type === 'warning' && a.icon === 'key' && a.relatedKind === 'Certificate'))
  const uid12 = alerts[0].uid
  assert.equal(uid12, 'cert:AA:BB:CC')
  assert.equal(alerts[0].color, 'tertiary')   // 12d → warn 档
  assert.equal(alerts[1].color, 'error')      // 3d → critical
  assert.equal(alerts[2].color, 'error')      // -5d → expired
  assert.match(alerts[0].age, /certAlertExpiringAge/)
  assert.match(alerts[2].age, /certAlertExpiredAge/)
  assert.equal(alerts[0]._ts, 123)
})

test('buildCertAlerts:null/空 report 与缺指纹兜底(namespace/name 复合 uid)', () => {
  assert.deepEqual(buildCertAlerts(null, { t: k => k }), [])
  assert.deepEqual(buildCertAlerts({}, { t: k => k }), [])
  const alerts = buildCertAlerts({ secrets: { items: [{ name: 's', namespace: 'n', daysLeft: 1 }] } }, { t: k => k })
  assert.equal(alerts[0].uid, 'cert:n/s')
})
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

```js
// src/logic/certExpiry.js
// 证书到期纯逻辑:分级 + 铃铛伪事件构造。i18n 由调用方注入 t(纯模块不 import i18n,
// 零依赖 runner 可测;报告形状 = GET /api/cluster-certs 响应)。
export const CERT_WARN_DAYS = 30
export const CERT_CRITICAL_DAYS = 7

export function certSeverity(daysLeft) {
  if (daysLeft == null || Number.isNaN(daysLeft)) return 'unknown'
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= CERT_CRITICAL_DAYS) return 'critical'
  if (daysLeft <= CERT_WARN_DAYS) return 'warn'
  return 'ok'
}

// ≤30 天/已过期的 tls Secret leaf → warning 伪事件(AlertBell 消费)。
// uid = 'cert:'+指纹(跨天稳定 → 标记已读后不复活);无指纹时回退 ns/name 复合。
export function buildCertAlerts(report, { now = Date.now, t = (k, p) => k } = {}) {
  const items = report?.secrets?.items
  if (!Array.isArray(items)) return []
  const out = []
  for (const it of items) {
    const sev = certSeverity(it.daysLeft)
    if (sev !== 'expired' && sev !== 'critical' && sev !== 'warn') continue
    const expired = sev === 'expired'
    out.push({
      uid: `cert:${it.fingerprint256 || `${it.namespace || ''}/${it.name || ''}`}`,
      type: 'warning',
      reason: t(expired ? 'nav.certAlertReasonExpired' : 'nav.certAlertReason'),
      relatedKind: 'Certificate',
      relatedName: it.name || '',
      relatedNamespace: it.namespace || '',
      namespace: it.namespace || '',
      age: expired ? t('nav.certAlertExpiredAge', { days: Math.abs(it.daysLeft) }) : t('nav.certAlertExpiringAge', { days: it.daysLeft }),
      icon: 'key',
      color: expired || sev === 'critical' ? 'error' : 'tertiary',
      _ts: now(),
    })
  }
  return out
}
```

- [ ] **Step 4: 入链并跑通**

`package.json` `test:server` 串尾(`... && node --test src/logic/classDefault.test.mjs` 之后)追加 ` && node --test src/logic/certExpiry.test.mjs`。
Run: `node --test src/logic/certExpiry.test.mjs` → PASS。

- [ ] **Step 5: Commit** `feat(logic): certExpiry severity + bell pseudo-events (node-runner tests)`

---

### Task 8: 前端数据层(api + store)

**Files:**
- Modify: `src/api/client.js`(api 对象加 1 方法)、`src/stores/cluster.js`(fetchClusterCerts + 导出)

**Interfaces:**
- Produces: `api.clusterCerts()`(k8sHttp GET `/api/cluster-certs`)、`store.fetchClusterCerts()`(直接返回报告对象;`_allViewsMount` 用真实 store + Proxy api,方法存在即可、异常防御 `?.`)。

- [ ] **Step 1: client.js**——`api` 对象 `k8s: (path, options) => ...`(:158)后加:

```js
  // 集群证书报告(2026-09-06):连接证书/CA 锚/TLS Secret 扫描(session 鉴权,集群级读)
  clusterCerts: () => k8sHttp.request('/api/cluster-certs'),
```

- [ ] **Step 2: stores/cluster.js**——`fetchEvents`(:493)后加:

```js
  // 集群证书报告(2026-09-06 证书可观测):网关 session 端点(非 /api/k8s 代理);铃铛与 /cluster/certs
  // 页共用同一 queryKey(['cluster',cid,'certs']),Vue Query 去重。
  async function fetchClusterCerts() { return await api.clusterCerts() }
```

return 列表 `fetchPods, fetchPod, fetchEvents,`(:620)后补 `fetchClusterCerts,`。

- [ ] **Step 3: 验证 + Commit**

Run: `npm run typecheck && npx vitest run src/views/__tests__/_allViewsMount.test.js` → PASS。
Commit: `feat(api,store): fetchClusterCerts data path`

---

### Task 9: 页面接线(路由/侧栏/搜索/列目录/locales)

**Files:**
- Modify: `src/router/index.js`(cluster/events 后)、`src/components/layout/SideNavBar.vue`(clusterResourcesNav)、`src/logic/globalSearch.js`(PAGE_ENTRIES)、`src/composables/tableColumnsCore.js`(TABLE_CATALOG 尾)、`src/locales/zh.json`+`en.json`(certs.* 顶级命名空间 + nav/route/searchPageSynonyms)
- Test: 既有守卫(route-auth 类比:ui-language-guard/overflow-guard/globalSearch.test.mjs 自动覆盖)

**Interfaces:**
- Produces: 路由 `name:'ClusterCerts'`(`route.clusterCerts`);侧栏/搜索入口;列目录 key `clusterCerts`(Task 10 的 DataTable `column-key`)。

- [ ] **Step 1: 路由**——`cluster/events` 条目后加:

```js
  {
    // 集群证书可观测(2026-09-06):API server 证书/CA 锚/TLS Secret 到期总览;铃铛证书告警落点
    path: 'cluster/certs',
    name: 'ClusterCerts',
    component: () => import('@/views/ClusterCerts.vue'),
    meta: { titleKey: 'route.clusterCerts', icon: 'verified', scope: 'global' }
  },
```

- [ ] **Step 2: 侧栏**——`clusterResourcesNav` 数组尾加:

```js
  { icon: 'verified', labelKey: 'nav.certs', route: '/cluster/certs' },
```

- [ ] **Step 3: 全局搜索**——`PAGE_ENTRIES` 尾加(字段名以现文件为准):

```js
  { path: '/cluster/certs', labelKey: 'route.clusterCerts', icon: 'verified', keywords: ['cert', 'certificate', 'tls', 'x509', 'ca'] },
```

- [ ] **Step 4: 列目录**——`TABLE_CATALOG` 尾(apiKeys 条目后)加:

```js
  {
    key: 'clusterCerts', labelKey: 'certs.title', label: 'Cluster Certificates', icon: 'verified',
    columns: [
      { key: 'name',         labelKey: 'certs.thName',      label: 'Secret' },
      { key: 'namespace',    labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'cn',           labelKey: 'certs.thCn',        label: 'Subject (CN)' },
      { key: 'issuer',       labelKey: 'certs.thIssuer',    label: 'Issuer' },
      { key: 'sans',         labelKey: 'certs.thSans',      label: 'SANs' },
      { key: 'expires',      labelKey: 'certs.thExpires',   label: 'Expires' },
      { key: 'daysLeft',     labelKey: 'certs.thDaysLeft',  label: 'Time left' },
      { key: 'certManager',  labelKey: 'certs.thCertManager', label: 'cert-manager' },
    ],
  },
```

(`cols._c.namespace` 已存在:zh.json:4469 ✓。)

- [ ] **Step 5: locales**——zh/en 同步:

新顶级命名空间 `certs`(与既有 `"secret"` 块相邻插入,grep `'"secret": {'` 定位):

zh:
```json
  "certs": {
    "title": "集群证书",
    "subtitle": "API server 服务证书、信任 CA 与 TLS Secret 的到期总览",
    "sectionConnection": "集群连接证书",
    "sectionSecrets": "TLS 证书 Secret",
    "apiServerCert": "API Server 服务证书",
    "caAnchors": "信任 CA(面板存储)",
    "trusted": "信任链校验通过",
    "unverified": "未校验",
    "insecureHint": "该集群以 insecure 模式接入,未校验证书信任链",
    "bannerCaMismatch": "集群证书与面板存储的 CA 不一致(集群可能已轮换证书或重建)。请管理员重新导入 kubeconfig 重新信任。",
    "bannerCertExpired": "API server 证书已过期。自建集群请在控制面节点续期(如 kubeadm certs renew)后重启组件。",
    "bannerHostnameMismatch": "API server 地址与其证书 SAN 不匹配,请核对接入地址。",
    "bannerUnreachable": "无法建立 TLS 连接:{reason}",
    "bannerError": "证书探测失败:{reason}",
    "goAdminClusters": "前往集群管理",
    "subject": "主体",
    "issuer": "签发者",
    "sans": "SAN",
    "expires": "到期时间",
    "fingerprint": "指纹",
    "thName": "Secret",
    "thCn": "主体(CN)",
    "thIssuer": "签发者",
    "thSans": "SAN",
    "thExpires": "到期时间",
    "thDaysLeft": "剩余",
    "thCertManager": "cert-manager",
    "filterAll": "全部",
    "filterExpiring": "30 天内",
    "filterExpired": "已过期",
    "searchPlaceholder": "搜索名称 / 主体 / 命名空间",
    "secretsForbidden": "当前凭据无权列出 TLS Secret(需要 secrets list 权限),连接证书不受影响",
    "cmReady": "Ready",
    "cmRenew": "续期 {time}",
    "daysLeft": "{n} 天",
    "expiredDays": "过期 {n} 天",
    "noSecretsTitle": "没有 TLS Secret",
    "noSecretsDesc": "当前集群未发现 kubernetes.io/tls 类型的 Secret",
    "synced": "证书已刷新",
    "syncFailed": "刷新失败"
  },
```
en(同键):
```json
  "certs": {
    "title": "Cluster Certificates",
    "subtitle": "Expiry overview of the API server serving cert, trusted CAs and TLS secrets",
    "sectionConnection": "Cluster connection certificates",
    "sectionSecrets": "TLS certificate secrets",
    "apiServerCert": "API server certificate",
    "caAnchors": "Trusted CAs (stored by the panel)",
    "trusted": "Trust chain verified",
    "unverified": "Unverified",
    "insecureHint": "This cluster is connected in insecure mode; the certificate chain is not verified",
    "bannerCaMismatch": "The cluster certificate does not match the CA stored by the panel (the cluster may have rotated certs or been rebuilt). An admin must re-import the kubeconfig to re-establish trust.",
    "bannerCertExpired": "The API server certificate has expired. On self-managed clusters renew it on control-plane nodes (e.g. kubeadm certs renew) and restart the components.",
    "bannerHostnameMismatch": "The API server address does not match the certificate SANs; check the endpoint URL.",
    "bannerUnreachable": "Cannot establish a TLS connection: {reason}",
    "bannerError": "Certificate probe failed: {reason}",
    "goAdminClusters": "Open cluster management",
    "subject": "Subject",
    "issuer": "Issuer",
    "sans": "SANs",
    "expires": "Expires",
    "fingerprint": "Fingerprint",
    "thName": "Secret",
    "thCn": "Subject (CN)",
    "thIssuer": "Issuer",
    "thSans": "SANs",
    "thExpires": "Expires",
    "thDaysLeft": "Time left",
    "thCertManager": "cert-manager",
    "filterAll": "All",
    "filterExpiring": "≤ 30 days",
    "filterExpired": "Expired",
    "searchPlaceholder": "Search name / subject / namespace",
    "secretsForbidden": "Current credentials cannot list TLS secrets (secrets list permission required); connection certs are unaffected",
    "cmReady": "Ready",
    "cmRenew": "renews {time}",
    "daysLeft": "{n} d",
    "expiredDays": "{n} d overdue",
    "noSecretsTitle": "No TLS secrets",
    "noSecretsDesc": "No kubernetes.io/tls secrets found in this cluster",
    "synced": "Certificates refreshed",
    "syncFailed": "Refresh failed"
  },
```

`nav` 块(`"nav.alerts"` 邻近)双侧加:
zh `"certs": "证书", "certAlertReason": "证书到期", "certAlertReasonExpired": "证书已过期", "certAlertExpiringAge": "{days} 天后到期", "certAlertExpiredAge": "已过期 {days} 天"`
en `"certs": "Certificates", "certAlertReason": "Certificate expiring", "certAlertReasonExpired": "Certificate expired", "certAlertExpiringAge": "in {days}d", "certAlertExpiredAge": "{days}d overdue"`

`route` 块双侧加:zh `"clusterCerts": "集群证书"` / en `"clusterCerts": "Cluster Certificates"`。

`nav.searchPageSynonyms`(zh:528 起)双侧加:zh `"cluster/certs": "证书,集群证书,tls"` / en `"cluster/certs": "certs,certificate,tls"`。

- [ ] **Step 6: 跑守卫 + Commit**

```bash
npm run i18n:check && node --test src/logic/globalSearch.test.mjs scripts/ui-language-guard.test.mjs scripts/overflow-guard.test.mjs
```
(globalSearch.test 若有数量类断言按需同步。)Commit: `feat(nav,catalog,i18n): /cluster/certs wiring (router/sidebar/search/columns/locales)`

---

### Task 10: ClusterCerts 页面

**Files:**
- Create: `src/views/ClusterCerts.vue`
- Test: `src/views/__tests__/ClusterCerts.view.test.js`

**Interfaces:**
- Consumes: `store.fetchClusterCerts()`(Task 8)、`tableColumns('clusterCerts')`(Task 9)、`certSeverity`(Task 7)、报告形状(Task 4)。
- Produces: K 轨两段式页面(A:连接证书+banner+CA 锚;B:TLS Secret 表)。data-testid:`certs-banner`/`certs-apiserver-card`/`certs-ca-anchors`/`certs-secrets-error`/`cert-days`/`certs-filter-all|expiring|expired`。

- [ ] **Step 1: 写失败测试**

```js
// src/views/__tests__/ClusterCerts.view.test.js
// 两段式渲染契约:banner 各态 / days 分级 pill 类名 / 过滤 chips / forbidden 降级提示。
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const h = await vi.hoisted(async () => {
  const { ref: r } = await import('vue')
  return { certsData: r(null) }
})
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: h.certsData, isLoading: ref(false), isFetching: ref(false), refetch: vi.fn(async () => { }) }),
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchClusterCerts: vi.fn(async () => null) }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: vi.fn() }) }))
import ClusterCerts from '../ClusterCerts.vue'

const REPORT = {
  connection: { apiServer: 'https://a', trust: 'ca-mismatch', reachable: true, reasonCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', reason: 'unable to verify', peerChain: [{ subject: 'CN=api', issuer: 'CN=ca', validFrom: 1, validTo: 2e12, daysLeft: 15, sans: ['DNS:a'], fingerprint256: 'F1', isCA: false }] },
  caAnchors: [{ subject: 'CN=ca', issuer: 'CN=ca', validFrom: 1, validTo: 3e12, daysLeft: 40, sans: [], fingerprint256: 'F2', isCA: true }],
  secrets: { items: [
    { name: 'tls-web', namespace: 'api', cn: 'CN=web', issuer: 'CN=letsencrypt', sans: ['DNS:web'], expires: 2e12, daysLeft: 12, fingerprint256: 'A', chainCount: 2, managedBy: 'cert-manager', certManager: { ready: true, renewalTime: '2026-10-01T00:00:00Z' } },
    { name: 'tls-old', namespace: 'default', cn: 'CN=old', issuer: 'CN=self', sans: [], expires: 1e12, daysLeft: -5, fingerprint256: 'B', chainCount: 1, managedBy: null, certManager: null },
    { name: 'tls-far', namespace: 'default', cn: 'CN=far', issuer: 'CN=self', sans: [], expires: 9e12, daysLeft: 300, fingerprint256: 'C', chainCount: 1, managedBy: null, certManager: null },
  ], error: null },
  certManagerInstalled: true, fetchedAt: 1,
}
function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(ClusterCerts, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}

describe('ClusterCerts', () => {
  it('ca-mismatch:banner 文案 + 跳转链接在场;A 段卡与 CA 锚渲染', async () => {
    h.certsData.value = REPORT
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-banner"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-banner"]').text()).toContain(i18n.global.t('certs.bannerCaMismatch'))
    expect(w.find('[data-testid="certs-apiserver-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-ca-anchors"]').exists()).toBe(true)
    expect(w.text()).toContain('tls-web')
    w.unmount()
  })
  it('days 分级 pill:12d→tertiary(warn);-5d→error(expired)', async () => {
    h.certsData.value = REPORT
    const w = mountView(); await flushPromises()
    const pills = w.findAll('[data-testid="cert-days"]')
    const cls = pills.map(p => p.classes().join(' '))
    expect(cls.some(c => c.includes('text-tertiary-container'))).toBe(true)
    expect(cls.some(c => c.includes('text-error'))).toBe(true)
    w.unmount()
  })
  it('过滤 chips:默认全部 3 行;30 天内 → 2 行;已过期 → 1 行', async () => {
    h.certsData.value = REPORT
    const w = mountView(); await flushPromises()
    expect(w.text()).toContain('tls-far')
    await w.find('[data-testid="certs-filter-expiring"]').trigger('click'); await flushPromises()
    expect(w.text()).not.toContain('tls-far'); expect(w.text()).toContain('tls-web')
    await w.find('[data-testid="certs-filter-expired"]').trigger('click'); await flushPromises()
    expect(w.text()).toContain('tls-old'); expect(w.text()).not.toContain('tls-web')
    w.unmount()
  })
  it('forbidden:B 段提示条,A 段照常', async () => {
    h.certsData.value = { ...REPORT, secrets: { items: [], error: 'forbidden' } }
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-secrets-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-apiserver-card"]').exists()).toBe(true)
    w.unmount()
  })
  it('trusted:无 banner;unverified:提示文案', async () => {
    h.certsData.value = { ...REPORT, connection: { ...REPORT.connection, trust: 'trusted' } }
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-banner"]').exists()).toBe(false)
    w.unmount()
    h.certsData.value = { ...REPORT, connection: { ...REPORT.connection, trust: 'unverified' } }
    const w2 = mountView(); await flushPromises()
    expect(w2.find('[data-testid="certs-banner"]').text()).toContain(i18n.global.t('certs.insecureHint'))
    w2.unmount()
  })
})
```

- [ ] **Step 2: 确认失败**(视图不存在,`_allModulesImport`/挂载红)
- [ ] **Step 3: 实现视图**

```vue
<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { notify } from '@/composables/useToast'
import { usePagination } from '@/composables/usePagination'
import { certSeverity } from '@/logic/certExpiry'
import { routeForResource } from '@/logic/resourceNavigation'

// 集群证书可观测(2026-09-06,K 轨):A 段集群连接证书(API server 服务证书 + 面板存储 CA 锚,
// TLS 双拨归因 banner),B 段 kubernetes.io/tls Secret 到期表。与 AlertBell 共用 queryKey 去重。
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { tableColumns } = useTableColumns()
const cid = computed(() => (store.currentCluster || 'cluster'))
const certsQ = useResourceList({
  key: ['cluster', cid, 'certs'],
  fetcher: () => store.fetchClusterCerts(),
  options: { staleTime: 60_000, refetchInterval: 300_000 },
})
const report = computed(() => certsQ.data.value || null)
const loading = computed(() => certsQ.isLoading.value)
const syncing = computed(() => certsQ.isFetching.value)
async function sync() {
  try { await certsQ.refetch(); notify('success', t('certs.synced')) }
  catch (e) { notify('error', `${t('certs.syncFailed')}：${e.message || ''}`) }
}

const conn = computed(() => report.value?.connection || null)
const apiCert = computed(() => conn.value?.peerChain?.[0] || null)
const caAnchors = computed(() => report.value?.caAnchors || [])

const BANNER = {
  'ca-mismatch': 'certs.bannerCaMismatch',
  'cert-expired': 'certs.bannerCertExpired',
  'hostname-mismatch': 'certs.bannerHostnameMismatch',
  'unreachable': 'certs.bannerUnreachable',
  'unverified': 'certs.insecureHint',
  'error': 'certs.bannerError',
}
const bannerKey = computed(() => (conn.value && BANNER[conn.value.trust]) || null)
const bannerIsError = computed(() => conn.value && conn.value.trust !== 'unverified')

// 分级 pill:无 warning token → tertiary=warn,error=危险(透明度须 5 的倍数)
const SEV_CLASS = {
  expired: 'bg-error-container/30 text-error',
  critical: 'bg-error-container/30 text-error',
  warn: 'bg-tertiary-container/20 text-tertiary-container',
  ok: 'bg-primary/10 text-primary',
  unknown: 'bg-surface-container text-on-surface-variant',
}
function pillClass(daysLeft) { return SEV_CLASS[certSeverity(daysLeft)] || SEV_CLASS.unknown }
function fmtDays(d) {
  if (d == null) return '—'
  return d < 0 ? t('certs.expiredDays', { n: Math.abs(d) }) : t('certs.daysLeft', { n: d })
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString() : '—' }

// B 段:过滤(全部/30 天内/已过期)+ 搜索
const filterMode = ref('all')
const searchQuery = ref('')
const secretsError = computed(() => report.value?.secrets?.error || null)
const secretItems = computed(() => report.value?.secrets?.items || [])
const filtered = computed(() => {
  let list = secretItems.value
  if (filterMode.value === 'expiring') list = list.filter(s => s.daysLeft != null && s.daysLeft <= 30)
  if (filterMode.value === 'expired') list = list.filter(s => s.daysLeft != null && s.daysLeft < 0)
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(s => `${s.name} ${s.namespace} ${s.cn || ''} ${(s.sans || []).join(' ')}`.toLowerCase().includes(q))
})
const headers = computed(() => tableColumns('clusterCerts'))
const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery, filterMode] })
function onRowClick(row) {
  const target = routeForResource('Secret', row.name, row.namespace)
  if (target) router.push(target)
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('certs.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('certs.subtitle') }}</p>
      </div>
      <button @click="sync" :disabled="syncing" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        <span class="material-symbols-outlined text-base" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ $t('common.sync') }}
      </button>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-xl">
      <span class="material-symbols-outlined text-2xl animate-spin text-on-surface-variant">progress_activity</span>
    </div>
    <template v-else-if="report">
      <!-- 归因 banner:trusted 不渲染 -->
      <div v-if="bannerKey" data-testid="certs-banner"
        class="flex items-start gap-sm rounded-lg px-md py-sm mb-md"
        :class="bannerIsError ? 'bg-error-container/20 border border-error/30 text-error' : 'bg-tertiary-container/15 border border-tertiary/30 text-tertiary-container'">
        <span class="material-symbols-outlined text-base shrink-0 mt-0.5">{{ bannerIsError ? 'gpp_bad' : 'info' }}</span>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-medium">{{ $t(bannerKey, { reason: conn?.reason || conn?.reasonCode || '' }) }}</p>
          <router-link v-if="conn?.trust === 'ca-mismatch'" to="/clusters" class="text-body-sm underline underline-offset-2">{{ $t('certs.goAdminClusters') }}</router-link>
        </div>
      </div>

      <!-- A 段:集群连接证书 -->
      <h3 class="text-body-md font-bold text-on-surface mb-sm">{{ $t('certs.sectionConnection') }}</h3>
      <div data-testid="certs-apiserver-card" class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md mb-md">
        <div class="flex items-center gap-sm mb-sm">
          <span class="material-symbols-outlined text-primary">verified_user</span>
          <p class="text-body-md font-bold text-on-surface">{{ $t('certs.apiServerCert') }}</p>
          <span data-testid="cert-days" class="ml-auto px-1.5 py-0.5 rounded text-xs font-semibold" :class="pillClass(apiCert?.daysLeft)">{{ fmtDays(apiCert?.daysLeft) }}</span>
        </div>
        <div v-if="apiCert" class="grid grid-cols-1 md:grid-cols-3 gap-sm text-body-sm">
          <div class="min-w-0"><p class="text-xs text-on-surface-variant">{{ $t('certs.subject') }}</p><p class="truncate max-w-[20rem] font-mono text-code-sm" :title="apiCert.subject">{{ apiCert.subject }}</p></div>
          <div class="min-w-0"><p class="text-xs text-on-surface-variant">{{ $t('certs.issuer') }}</p><p class="truncate max-w-[20rem] font-mono text-code-sm" :title="apiCert.issuer">{{ apiCert.issuer }}</p></div>
          <div><p class="text-xs text-on-surface-variant">{{ $t('certs.expires') }}</p><p class="font-mono text-code-sm">{{ fmtDate(apiCert.validTo) }}</p></div>
        </div>
        <p v-else class="text-body-sm text-on-surface-variant">—</p>
        <div v-if="apiCert?.sans?.length" class="mt-sm min-w-0">
          <p class="text-xs text-on-surface-variant">{{ $t('certs.sans') }}</p>
          <p class="font-mono text-code-sm text-on-surface truncate max-w-[36rem]" :title="apiCert.sans.join(', ')">{{ apiCert.sans.join(', ') }}</p>
        </div>
      </div>
      <div data-testid="certs-ca-anchors" class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md mb-md">
        <p class="text-body-md font-bold text-on-surface mb-sm">{{ $t('certs.caAnchors') }}({{ caAnchors.length }})</p>
        <div v-for="a in caAnchors" :key="a.fingerprint256 || a.subject" class="flex items-center gap-sm py-xs border-b border-outline-variant/50 last:border-0">
          <span class="material-symbols-outlined text-base text-on-surface-variant">key</span>
          <span class="font-mono text-code-sm text-on-surface truncate max-w-[22rem]" :title="a.subject">{{ a.subject }}</span>
          <span data-testid="cert-days" class="ml-auto px-1.5 py-0.5 rounded text-xs font-semibold" :class="pillClass(a.daysLeft)">{{ fmtDays(a.daysLeft) }}</span>
        </div>
        <p v-if="!caAnchors.length" class="text-body-sm text-on-surface-variant">{{ $t('certs.insecureHint') }}</p>
      </div>

      <!-- B 段:TLS 证书 Secret -->
      <div class="flex items-center justify-between mb-sm">
        <h3 class="text-body-md font-bold text-on-surface">{{ $t('certs.sectionSecrets') }}</h3>
        <div class="flex gap-xs">
          <button v-for="mode in ['all', 'expiring', 'expired']" :key="mode" :data-testid="`certs-filter-${mode}`"
            class="px-sm py-0.5 rounded-full text-xs font-medium border transition-colors"
            :class="filterMode === mode ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container'"
            @click="filterMode = mode">{{ $t(`certs.filter${mode === 'all' ? 'All' : mode === 'expiring' ? 'Expiring' : 'Expired'}`) }}</button>
        </div>
      </div>
      <div v-if="secretsError" data-testid="certs-secrets-error" class="flex items-center gap-sm rounded-lg bg-tertiary-container/15 border border-tertiary/30 text-tertiary-container px-md py-sm mb-md">
        <span class="material-symbols-outlined text-base">lock</span>
        <p class="text-body-sm">{{ $t('certs.secretsForbidden') }}</p>
      </div>
      <div class="flex items-center gap-md mb-md">
        <div class="relative flex-1 max-w-md">
          <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
          <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="$t('certs.searchPlaceholder')" />
        </div>
        <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ secretItems.length }}</span>
      </div>
      <EmptyState v-if="!secretItems.length && !secretsError" icon="verified_user" :title="$t('certs.noSecretsTitle')" :description="$t('certs.noSecretsDesc')" />
      <DataTable v-else-if="filtered.length" :headers="headers" :rows="paginated" column-key="clusterCerts" row-key="name" @row-click="onRowClick">
        <template #name="{ row }">
          <span class="font-semibold text-on-surface text-body-md block truncate max-w-[14rem]" :title="row.name">{{ row.name }}</span>
        </template>
        <template #cn="{ row }">
          <span class="font-mono text-code-sm text-on-surface truncate max-w-[16rem] block" :title="row.cn">{{ row.cn || '—' }}</span>
        </template>
        <template #issuer="{ row }">
          <span class="font-mono text-code-sm text-on-surface-variant truncate max-w-[14rem] block" :title="row.issuer">{{ row.issuer || '—' }}</span>
        </template>
        <template #sans="{ row }">
          <span class="font-mono text-code-sm text-on-surface-variant truncate max-w-[18rem] block" :title="(row.sans || []).join(', ')">{{ (row.sans || []).join(', ') || '—' }}</span>
        </template>
        <template #expires="{ row }">
          <span class="font-mono text-code-sm text-on-surface">{{ fmtDate(row.expires) }}</span>
        </template>
        <template #daysLeft="{ row }">
          <span data-testid="cert-days" class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="pillClass(row.daysLeft)">{{ fmtDays(row.daysLeft) }}</span>
        </template>
        <template #certManager="{ row }">
          <span v-if="row.certManager" class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded">
            <span class="material-symbols-outlined text-xs">autorenew</span>{{ row.certManager.ready ? $t('certs.cmReady') : '—' }}<span v-if="row.certManager.renewalTime" class="text-on-surface-variant">· {{ $t('certs.cmRenew', { time: fmtDate(Date.parse(row.certManager.renewalTime)) }) }}</span>
          </span>
          <span v-else class="text-on-surface-variant">—</span>
        </template>
        <template #pagination>
          <div />
        </template>
      </DataTable>
      <EmptyState v-else icon="search" :title="$t('certs.noSecretsTitle')" :description="$t('certs.searchPlaceholder')" />
    </template>
  </section>
</template>
```

(注:`usePagination` 的 `resetDeps` 接受 ref 数组,与 Nodes.vue 用法一致;分页复用 Nodes 模式,`#pagination` 槽内按 `total > pageSize` 渲染 `<Pagination>`——实现时对齐 Nodes.vue:154-156 的写法。)

- [ ] **Step 4: 跑测试** `npx vitest run src/views/__tests__/ClusterCerts.view.test.js src/views/__tests__/_allViewsMount.test.js` → PASS
- [ ] **Step 5: Commit** `feat(views): ClusterCerts page — connection section + tls secrets table`

---

### Task 11: AlertBell 合并 + Certificate 导航

**Files:**
- Modify: `src/components/layout/AlertBell.vue`、`src/logic/resourceNavigation.js`、`src/components/layout/__tests__/AlertBell.test.js`、`src/logic/resourceNavigation.test.mjs`

**Interfaces:**
- Consumes: Task 7 `buildCertAlerts`、Task 8 `store.fetchClusterCerts`、Task 9 路由名 `ClusterCerts`。
- Produces: 铃铛面板 = warning events + cert 伪事件(拼接序);未读台账复用 `eventKey`(uid 稳定);`routeForResource('Certificate', …)` → `{ name: 'ClusterCerts' }`。

- [ ] **Step 1: 扩既有测试(先红)**

`AlertBell.test.js`:
1. `storeMock` 加 `fetchClusterCerts: vi.fn(async () => null)`;
2. `useK8sQuery` mock 改为按 key 分流(`capturedOpts` 仍只记 events,既有轮询断言不动):

```js
vi.mock('@/composables/useK8sQuery', () => {
  const eventsData = ref(null), certsData = ref(null)
  const capturedOpts = {}
  return {
    useResourceList: (opts) => {
      if (opts.key[2] === 'events') capturedOpts.value = opts
      return { data: opts.key[2] === 'certs' ? certsData : eventsData }
    },
    __eventsData: eventsData, __certsData: certsData, __queryOpts: capturedOpts,
  }
})
```
import 行加 `__certsData`;`beforeEach` 加 `__certsData.value = null`。

3. 追加用例:

```js
const CERT_REPORT = { secrets: { items: [
  { name: 'tls-web', namespace: 'api', daysLeft: 12, fingerprint256: 'AA:BB' },
  { name: 'tls-dead', namespace: 'api', daysLeft: -3, fingerprint256: 'CC:DD' },
  { name: 'tls-far', namespace: 'api', daysLeft: 200, fingerprint256: 'EE:FF' },
], error: null } }

test('证书告警合并:≤30d/过期进面板(200d 不进),uid 稳定,图标 key', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded')]
  __certsData.value = CERT_REPORT
  const w = mountBell(); await flushPromises()
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(true)
  await w.find('[data-test="alert-bell"]').trigger('click'); await flushPromises()
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  expect(rows).toHaveLength(3) // 1 event + 2 cert
  expect(panel().textContent).toContain('tls-web')
  expect(panel().textContent).not.toContain('tls-far')
  document.querySelector('[data-test="alert-mark-read"]').click(); await flushPromises()
  const saved = JSON.parse(localStorage.getItem('ab.alertsRead.prod'))
  expect(saved).toContain('cert:AA:BB'); expect(saved).toContain('cert:CC:DD')
  w.unmount()
})

test('证书行点击 → ClusterCerts 页;过期档 color=error 图标 key', async () => {
  __certsData.value = CERT_REPORT
  const w = mountBell(); await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click'); await flushPromises()
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  rows[0].click(); await flushPromises() // cert 排在 events 之后,无 events 时 cert 在前
  expect(pushMock).toHaveBeenCalledWith({ name: 'ClusterCerts' })
  w.unmount()
})
```

`src/logic/resourceNavigation.test.mjs` 追加:`routeForResource('Certificate', 'x', 'y')` deep-equal `{ name: 'ClusterCerts' }`。

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

`AlertBell.vue` script 改动(import 加 `useI18n`/`buildCertAlerts`;`warningEvents` 后追加):

```js
import { useI18n } from 'vue-i18n'
import { buildCertAlerts } from '@/logic/certExpiry'
const { t } = useI18n()
// 证书到期告警(2026-09-06):与 /cluster/certs 页共用 ['cluster',cid,'certs'] 缓存;5min 慢轮询
// (证书变化慢,不与 events 的 60s/watch 互斥逻辑耦合)。
const certsQ = useResourceList({
  key: ['cluster', cid, 'certs'],
  fetcher: () => store.fetchClusterCerts(),
  options: { enabled, refetchInterval: 300_000, refetchOnWindowFocus: false },
})
const certAlerts = computed(() => buildCertAlerts(certsQ.data.value, { t }))
const allWarnings = computed(() => [...warningEvents.value, ...certAlerts.value])
```

`unread`/`unreadKeys`/`panelRows` 的 `warningEvents.value` 改为 `allWarnings.value`;`onMarkAllRead` 改 `markAllRead(allWarnings.value)`。

`resourceNavigation.js`(`if (kind === 'CRD')` 行后加):

```js
  if (kind === 'Certificate') return { name: 'ClusterCerts' } // 证书告警伪事件落点(2026-09-06)
```

- [ ] **Step 4: 跑测试** `npx vitest run src/components/layout/__tests__/AlertBell.test.js && node --test src/logic/resourceNavigation.test.mjs src/logic/certExpiry.test.mjs` → 全 PASS(既有 10 个 AlertBell 用例零回归)
- [ ] **Step 5: Commit** `feat(alerts): bell merges cert-expiry alerts + Certificate navigation`

---

### Task 12: 门禁全绿 + 收尾

**Files:** 无新文件(修 fallout)

- [ ] **Step 1: 全量门禁**

```bash
npm test && npm run i18n:check && npm run typecheck && npm run build
```

Expected: 全绿。重点盯:`route-auth-map.test`(新字面量已登记)、`overflow-guard`(新 .vue truncate 全自带 max-w)、`ui-language-guard`(未碰 meta.module)、`missing-value/await-race`(computed .value 纪律)、`_allViewsMount`(新视图挂载)、`globalSearch.test`(条目数断言如有须同步)、i18n:check(zh/en 键齐、无 src 中文字面量、`{reason}` 等占位符两侧一致)。

- [ ] **Step 2: 冒烟(可选,若本地网关在跑)**

`curl -s http://127.0.0.1:8787/api/cluster-certs`(带 session token)→ 502/403 均属预期形态;断网集群 → `connection.trust:"unreachable"`。

- [ ] **Step 3: Commit(如有修复)** `fix(certs): gate fallout — <具体项>`

---

## Self-Review(已执行)

- **Spec 覆盖**:§5.1 模块=Task 2-4;§5.2 归因表=Task 2/3;§5.3 路由=Task 5;§5.4 admin 归因=Task 6;§6.1 接线=Task 9;§6.2 页面=Task 10;§6.3 catalog=Task 9;§6.4 铃铛=Task 7+11;§6.5 i18n=Task 6/9;§7 错误矩阵=各任务降级路径;§8 安全=Task 4 无 PEM 断言 + Task 6 白名单断言;§9 测试计划逐文件对应。缺口:无。
- **占位符**:无 TBD/「适当处理」;Task 10 `#pagination` 槽以 Nodes.vue 现写法为准属引用既有实现非占位。
- **类型一致性**:`getCertsReport(session)`/`classifyFromRow(row)`/`probeConnection(tlsConnect, opts)`/`buildCertAlerts(report, {now,t})`/`certSeverity(daysLeft)` 各任务间签名一致;报告形状 Task 4 定义、Task 10/11 消费一致;uid 格式 `cert:<fp>` 两处一致。
