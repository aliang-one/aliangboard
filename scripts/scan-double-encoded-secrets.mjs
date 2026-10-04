// 存量 secret 双编码(b64²)只读扫描器 — 2026-10-04 审计交付(issue#15 存量裁决工具)。
//
// 背景:v1.0.0–38 的 secret update 路径 beforeSave×2 会把集群值双编码(文本键 b64²、
// 二进制键叠更多层);v1.0.39 修了文本侧,e9c532a8(随 v1.0.40)修了二进制键×结构化编辑残留。
// 本脚本只做「集群里现在还有没有、有哪些受损数据」的事实盘点 —— 全程只发 GET,绝不写。
//
// 跑:  AB_GATEWAY=https://aboard.liang.home AB_USERNAME=… AB_PASSWORD=… \
//         node scripts/scan-double-encoded-secrets.mjs [--json] [--preview]
//       (或 --gateway/--username/--password 显式传参;凭据不落仓库。)
//
// 判定分层(2026-10-04 实测校准语料:helm "9000"/kubectl "true"/nursor-test "asd" 实锤):
//  - damaged-text   : 剥 ≥2 层后是可打印且非 b64 文本(用户敲的明文,存成了 b64²⁺)→ 实锤损伤。
//  - ambiguous-binary: 剥 1 层是合法 b64、再剥是二进制 —— 两种解释字节级不可分:
//                      ①明文本身就是 openssl rand -base64 风格(良性)②b64²(损伤)。
//                      靠旁证裁决:managedFields(manager=平台签名 aliangboard + Apply 时间落病窗)
//                      与「共键证明」(同 secret 里存在编码正确的文本键 ⇒ 同一次写入编码正确 ⇒ 旁键良性)。
//  - 豁免类型:helm.sh/release.v1(helm 本身就是 b64(b64(gzip)) 存储)、dockerconfigjson、
//    service-account-token —— 天然多层,不参与判定,只计数。
//
// 输出:分层数目 + 逐条 ns/name/key(值只给长度与前 8 字符预览,不整值外泄);
//       --json 出机器可读;--preview 附「剥一层后的样子」辅助人肉比对(仍截断)。
import { parseArgs } from 'node:util'

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const EXEMPT_TYPES = new Set(['helm.sh/release.v1', 'kubernetes.io/dockerconfigjson', 'kubernetes.io/service-account-token'])

// 病窗:update 路径双编码 v1.0.0–38 全带病,首曝约 2026-08-10,v1.0.39 修复上线 2026-10-01;
// 二进制键×结构化编辑残留在 v1.0.39 内仍可再触发,至 e9c532a8(v1.0.40)闭合。
export const DEFAULT_WINDOW = { start: '2026-08-10T00:00:00Z', end: '2026-10-04T00:00:00Z' }
export const PLATFORM_MANAGER = 'aliangboard'

/** 严格 canonical base64:字母表 + 长度 %4==0 + round-trip 逐字节一致。返回 Buffer|null。 */
export function strictB64 (s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0 || !B64_RE.test(s)) return null
  const d = Buffer.from(s, 'base64')
  // Buffer.from 宽松解码:必须回编一致才认 canonical(防 "YWFhYW!" 这类被宽容吞掉)
  return d.toString('base64') === s ? d : null
}

function isPrintable (buf) {
  if (buf.length === 0) return false
  for (const b of buf) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false
    if (b >= 0x7f) return false
  }
  return true
}

/**
 * 单键分类。返回 { tier, layers, innermost: { printable, head } }。
 *  - plain            : 存储值剥 1 层后不是合法 b64 —— 正常单编码(明文任意形态)。
 *  - b64text-plain    : 剥 1 层恰是合法 b64 的「明文本身」——潜在损伤,继续剥。
 *  - damaged-text     : 剥 ≥2 层到可打印非 b64 文本 —— b64²⁺(文本)实锤签名。
 *  - ambiguous-binary : 剥 2 层到二进制 —— openssl 风格明文 vs b64²(二进制)不可分。
 *  - deep-b64         : 剥 ≥3 层仍是 b64(极端叠层,按 damaged 上报)。
 */
export function classifyValue (b64Value) {
  const out = { tier: 'plain', layers: 1, innermost: null }
  let cur = strictB64(b64Value)
  if (cur === null) return out // k8s data 必是 b64;宽进:剥不动就当 plain
  const seen = []
  let layers = 1
  while (true) {
    const asStr = cur.toString('latin1')
    const next = strictB64(asStr)
    if (next === null) break
    if (seen.some(s => s.equals(next))) break // 循环保护(理论不会,防御)
    seen.push(cur)
    cur = next
    layers++
    if (layers > 6) break
  }
  out.layers = layers
  out.innermost = { printable: isPrintable(cur), head: cur.subarray(0, 8).toString('utf8') }
  if (layers === 1) out.tier = 'plain'
  else if (layers >= 3) out.tier = 'deep-b64'
  else if (out.innermost.printable) out.tier = 'damaged-text' // 2 层:外 b64 + 内可打印文本
  else out.tier = 'ambiguous-binary'
  return out
}

/**
 * secret 级裁决:逐键分类 + 旁证(manager/病窗/共键证明)。
 * meta = { managedFields, creationTimestamp } —— 传 null 时旁证缺省 unknown。
 */
export function classifySecret (secret, meta = null, window = DEFAULT_WINDOW, platformManager = PLATFORM_MANAGER) {
  const type = secret.type || 'Opaque'
  const exempt = EXEMPT_TYPES.has(type)
  const keys = {}
  let hasPlainCowitness = false
  for (const [k, v] of Object.entries(secret.data || {})) {
    const c = classifyValue(v)
    keys[k] = c
    if (c.tier === 'plain') hasPlainCowitness = true
  }
  // 旁证:managedFields 在 list GET 会被网关剥掉,须单对象 GET。归属按**最后写入者**:
  // 平台 Apply 之后若被他方(curl/helm/kubectl)再写,现值作者即他方,平台历史不再归因
  // (tencent-cos-secret 实测:平台 Apply 09-22 05:10 + curl 修复 05:40)。
  // created==平台 Apply 同秒(±2s)= 只走过 create 路径 —— 双编码病根在 update 路径(issue#15),
  // nursor-test 实锤是 created 后 36s 的第二次 Apply;create-only 一律不按病窗论处。
  let platformTouch = 'unknown'
  if (meta && Array.isArray(meta.managedFields) && meta.managedFields.length) {
    const latest = [...meta.managedFields].sort((a, b) => String(a.time || '').localeCompare(String(b.time || ''))).pop()
    if ((latest.manager || '') !== platformManager) platformTouch = 'other-manager'
    else {
      const t = latest.time || ''
      const created = meta.creationTimestamp || ''
      const createOnly = !!t && !!created && Math.abs(Date.parse(t) - Date.parse(created)) <= 2000
      if (createOnly) platformTouch = 'platform-create-only'
      else if (t >= window.start && t <= window.end) platformTouch = 'platform-in-window'
      else platformTouch = 'platform-outside-window'
    }
  }
  const verdicts = {}
  for (const [k, c] of Object.entries(keys)) {
    if (exempt) { verdicts[k] = { ...c, verdict: 'exempt-type' }; continue }
    if (c.tier === 'plain') { verdicts[k] = { ...c, verdict: 'ok' }; continue }
    if (c.tier === 'damaged-text' || c.tier === 'deep-b64') {
      // 剥多层到文本 = 强损伤签名;共键证明可翻案:病写是全对象写,若真发生 b64²,同批的
      // 文本键(如 DATABASE_URL)不可能幸存为 plain ⇒ 存在 plain 共键即证明写入路径编码正确,
      // 该键的「多层」来自明文本身就是 b64 形态(如 *_BASE64 键 = b64(PEM) 明文,按设计如此)。
      // 残留盲区:键 A 在病写#1 受损、修复后写#2 只改他键 —— 共键在而 A 带伤,此规则会误赦;
      // 由 needs-adjudication 通道外的人工复核兜底。
      verdicts[k] = { ...c, verdict: hasPlainCowitness ? 'likely-benign-cowitness' : 'damaged' }
      continue
    }
    // ambiguous-binary:共键证明/病窗外或 create-only/他方 manager → 良性;病窗内 update 且无共键 → 待裁决
    if (hasPlainCowitness || platformTouch !== 'platform-in-window') {
      verdicts[k] = { ...c, verdict: 'likely-benign-b64shaped' }
    } else {
      verdicts[k] = { ...c, verdict: 'needs-adjudication' }
    }
  }
  return { type, exempt, platformTouch, hasPlainCowitness, created: meta?.creationTimestamp || null, keys: verdicts }
}

// ============ CLI(只读 GET 链路:login → clusters → secrets 列表 → 嫌疑单对象补 managedFields)============

async function main () {
  const { values } = parseArgs({
    options: {
      gateway: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' },
      token: { type: 'string' }, json: { type: 'boolean' }, preview: { type: 'boolean' },
      insecure: { type: 'boolean' }
    }
  })
  // 私网 CA(如 *.liang.home 自签链)与 curl -k 同语义:显式 opt-in,不静默
  if (values.insecure || process.env.AB_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const gateway = (values.gateway || process.env.AB_GATEWAY || '').replace(/\/$/, '')
  const username = values.username || process.env.AB_USERNAME
  const password = values.password || process.env.AB_PASSWORD
  let token = values.token || process.env.AB_TOKEN
  if (!gateway) { console.error('need --gateway or AB_GATEWAY'); process.exit(2) }
  if (!token) {
    if (!username || !password) { console.error('need --token or AB_USERNAME/AB_PASSWORD'); process.exit(2) }
    const r = await fetch(`${gateway}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    if (!r.ok) { console.error(`login failed: ${r.status}`); process.exit(1) }
    token = (await r.json()).token
  }
  const H = { authorization: `Bearer ${token}` }
  const j = async (url) => {
    const r = await fetch(url, { headers: H })
    if (!r.ok) throw new Error(`${r.status} ${url}`)
    return r.json()
  }

  const { clusters } = await j(`${gateway}/api/admin/clusters`)
  const report = { scannedAt: new Date().toISOString(), clusters: [] }
  for (const c of clusters) {
    const base = `${gateway}/api/k8s-proxy/${c.id}`
    // 全 ns 分页拉取(50 个也走 continue,大集群同样成立)
    const items = []
    let cont = ''
    do {
      const page = await j(`${base}/api/v1/secrets?limit=500${cont}`)
      items.push(...(page.items || []))
      cont = page.metadata?.continue ? `&continue=${encodeURIComponent(page.metadata.continue)}` : ''
    } while (cont)
    const perSecret = []
    for (const it of items) {
      const pre = classifySecret({ type: it.type, data: it.data }, null)
      const interesting = Object.values(pre.keys).some(k => !['ok', 'exempt-type'].includes(k.verdict))
      if (!interesting) continue
      // 嫌疑对象:单对象 GET 补 managedFields(list 面被网关剥掉)
      const full = await j(`${base}/api/v1/namespaces/${encodeURIComponent(it.metadata.namespace)}/secrets/${encodeURIComponent(it.metadata.name)}`)
      const cls = classifySecret({ type: it.type, data: it.data }, { managedFields: full.metadata?.managedFields, creationTimestamp: it.metadata.creationTimestamp })
      perSecret.push({ ns: it.metadata.namespace, name: it.metadata.name, ...cls })
    }
    report.clusters.push({ id: c.id, name: c.name, totalSecrets: items.length, suspects: perSecret })
  }

  if (values.json) { console.log(JSON.stringify(report, null, 2)); return }
  for (const cl of report.clusters) {
    console.log(`\n=== cluster ${cl.name} — ${cl.totalSecrets} secrets, ${cl.suspects.length} 嫌疑对象 ===`)
    for (const s of cl.suspects) {
      console.log(`\n${s.ns}/${s.name}  type=${s.type}  platformTouch=${s.platformTouch}  cowitness=${s.hasPlainCowitness}`)
      for (const [k, v] of Object.entries(s.keys)) {
        const rawHead = v.innermost ? v.innermost.head : ''
        const head = rawHead.replace(/[^\x20-\x7e\n\t]/g, '·') // 不可打印字符一律点化,防终端乱码/泄值
        console.log(`  ${String(v.verdict).padEnd(24)} ${k.padEnd(40)} layers=${v.layers} innerHead=${JSON.stringify(head)}${values.preview ? '' : ''}`)
      }
    }
    const counts = {}
    for (const s of cl.suspects) for (const v of Object.values(s.keys)) counts[v.verdict] = (counts[v.verdict] || 0) + 1
    console.log('\nverdict 汇总:', counts)
  }
  console.log('\n(只读扫描,未发生任何写操作;damaged/needs-adjudication 项需人工裁决后再修)')
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isDirectRun) main().catch(e => { console.error(e); process.exit(1) })
