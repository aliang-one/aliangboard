// 自研零依赖 i18n 检查器：扫「残存用户可见中文」+ zh/en 键对齐。
// 用法： node scripts/i18n-check.mjs [paths...]   （默认 src）
// 残存>0 或键不对齐时退出码 1。排除：注释、console.*、locales/mock/__tests__/*.test.*。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const CJK = /[一-鿿]/
const SKIP = ['node_modules', 'locales', 'mock'] // 路径片段
const isSkip = (p) => SKIP.some(s => p.includes(s)) || /(__tests__|\.test\.)/.test(p)
const loadJson = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'))

// 纯扫描：不过滤路径（路径过滤由 walk 负责），便于测试直接对夹具调用。
// 先剥离注释（// 行注释、/* */ 块注释、<!-- --> HTML 注释，含跨行），再判 CJK，
// 避免把「代码 + 行尾中文注释」误报为残存。
export function scanSource(file) {
  if (!fs.existsSync(file)) return []
  const hits = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const state = { inBlock: false, inHtml: false }
  lines.forEach((raw, i) => {
    const code = stripComments(raw, state) // 跨行维护 state
    if (!CJK.test(code)) return
    if (/console\.(log|warn|error|info|debug)\s*\(/.test(code)) return
    hits.push({ file, line: i + 1, text: raw.trim() })
  })
  return hits
}

// 逐字符剥离注释，返回「代码部分」；state 在多行块注释间延续。
function stripComments(raw, state) {
  let out = ''
  let i = 0
  const s = raw
  while (i < s.length) {
    if (state.inBlock) {
      const end = s.indexOf('*/', i)
      if (end === -1) return out
      state.inBlock = false
      i = end + 2
      continue
    }
    if (state.inHtml) {
      const end = s.indexOf('-->', i)
      if (end === -1) return out
      state.inHtml = false
      i = end + 3
      continue
    }
    if (s.startsWith('/*', i)) { state.inBlock = true; i += 2; continue }
    if (s.startsWith('//', i)) return out // 行注释：本行后续全部丢弃
    if (s.startsWith('<!--', i)) { state.inHtml = true; i += 4; continue }
    out += s[i++]
  }
  return out
}

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (isSkip(p)) continue
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

function flat(o, p = '') {
  const r = []
  for (const k in o) {
    const kk = p ? `${p}.${k}` : k
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) r.push(...flat(o[k], kk))
    else r.push(kk)
  }
  return r
}

export function parity() {
  const zh = loadJson('../src/locales/zh.json'), en = loadJson('../src/locales/en.json')
  const fz = new Set(flat(zh)), fe = new Set(flat(en))
  return { onlyZh: [...fz].filter(k => !fe.has(k)), onlyEn: [...fe].filter(k => !fz.has(k)) }
}

// 抽取一个文件里所有「静态字面量」t() 键引用（$t('a.b') / t("a.b") / i18n.global.t(`a.b`)）。
// 动态键（t(var)）无法静态解析，跳过。先剥注释，避免注释里的 t('x') 误报。
const KEY_REF_RE = /\bt\(\s*['"`]([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)['"`]/g
export function extractKeyRefs(file) {
  if (!fs.existsSync(file)) return []
  const hits = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const state = { inBlock: false, inHtml: false }
  lines.forEach((raw, i) => {
    const code = stripComments(raw, state)
    let m
    KEY_REF_RE.lastIndex = 0
    while ((m = KEY_REF_RE.exec(code))) hits.push({ key: m[1], line: i + 1 })
  })
  return hits
}

// 全树扫描：返回被引用但 locale 里不存在的键（即会渲染成原始键路径的「未翻译」）。
export function missingKeys() {
  const zh = loadJson('../src/locales/zh.json')
  const keys = new Set(flat(zh))
  const out = [] // { key, file, line }
  const seen = new Set()
  for (const f of walk('src')) {
    for (const r of extractKeyRefs(f)) {
      if (keys.has(r.key)) continue
      const id = `${r.key}@${f}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ key: r.key, file: f, line: r.line })
    }
  }
  return out
}

// 重复键检测：JSON.parse 会静默丢弃同名前者（合并丢键的另一形态），parity() 基于解析后
// 对象也看不到。逐行扫原文按「事件序列」推导每个键的完整路径：
//   - 字符串（含值里的 {name}/裸花括号）先剥离，不影响结构判定
//   - 数组兄弟对象用匿名帧区分（[{a:1},{a:2}] 的同名键不算重复）
export function duplicateKeys(files) {
  const defaults = ['zh', 'en'].map(l => fileURLToPath(new URL(`../src/locales/${l}.json`, import.meta.url)))
  const out = []
  for (const file of (files || defaults)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const frames = []            // 栈：每层 { path }，根为 { path: '' }
    const seen = new Map()       // parentPath -> Map(key -> 首次行号)
    let anon = 0
    lines.forEach((raw, i) => {
      let pendingKey = null      // 键与其开括号在 pretty JSON 中必同行；行末清空防跨行误挂
      for (const e of lineEvents(raw)) {
        if (e.t === 'close') { frames.pop(); continue }
        if (e.t === 'key') {
          pendingKey = e.name
          const parent = frames[frames.length - 1].path
          let m = seen.get(parent)
          if (!m) { m = new Map(); seen.set(parent, m) }
          if (m.has(e.name)) out.push({ file, path: `${parent}${parent ? '.' : ''}${e.name}`, line: i + 1 })
          else m.set(e.name, i + 1)
          continue
        }
        // open：由同行的 pendingKey 命名；裸 {/[（数组兄弟对象）用匿名帧
        const parent = frames.length ? frames[frames.length - 1].path : ''
        const p = pendingKey != null
          ? `${parent}${parent ? '.' : ''}${pendingKey}`
          : (frames.length ? `${parent}#${anon++}` : '')
        frames.push({ path: p })
      }
    })
  }
  return out
}

// 把一行拆成按出现顺序的结构事件：open({/[)、close(}/])、key(后面跟冒号的字符串)。
// 字符串段整体跳过（键与值都剥离），只用「下一个非字符串段是否以 : 开头」识别键。
function lineEvents(line) {
  const ev = []
  const strRe = /"(?:[^"\\]|\\.)*"/g
  const strings = []
  let m
  while ((m = strRe.exec(line))) strings.push({ start: m.index, end: strRe.lastIndex, raw: m[0] })
  const seq = [] // [{str:false,text}, {str:true,text}, ...] 交替
  let prev = 0
  for (const s of strings) { seq.push({ str: false, text: line.slice(prev, s.start) }); seq.push({ str: true, text: s.raw }); prev = s.end }
  seq.push({ str: false, text: line.slice(prev) })
  for (let i = 0; i < seq.length; i++) {
    const seg = seq[i]
    if (!seg.str) {
      for (const ch of seg.text) {
        if (ch === '{' || ch === '[') ev.push({ t: 'open' })
        else if (ch === '}' || ch === ']') ev.push({ t: 'close' })
      }
    } else {
      const next = seq[i + 1] ? seq[i + 1].text : ''
      if (/^\s*:/.test(next)) ev.push({ t: 'key', name: JSON.parse(seg.text) })
    }
  }
  return ev
}

// 值级语法审计（vue-i18n 运行时才炸的坑，键检查覆盖不到）：
//   phMismatch    zh/en 占位符集合不一致 → 插值缺参/警告
//   bareAt        裸 @（未写成 {'@'}）→ Invalid linked format 崩溃
//   pipe          {} 外的顶层 | → 被当复数分支
//   brokenLink    @:target 链接的 target 键不存在
//   emptyValue    zh/en 双空 → 死键（单侧空是有意省略，如量词「个」，不报）
//   arrayMismatch 数组值类型/长度错位
export function valueIssues(zhMsgs, enMsgs) {
  const zh = zhMsgs || loadJson('../src/locales/zh.json')
  const en = enMsgs || loadJson('../src/locales/en.json')
  const keys = new Set([...flat(zh), ...flat(en)])
  const get = (o, k) => k.split('.').reduce((a, c) => (a == null ? a : a[c]), o)
  const PH = /\{[^{}]+\}/g
  const out = []
  for (const k of keys) {
    const z = get(zh, k), e = get(en, k)
    if (typeof z === 'string' && typeof e === 'string') {
      const zp = (z.match(PH) || []).sort().join(','), ep = (e.match(PH) || []).sort().join(',')
      if (zp !== ep) out.push({ key: k, locale: 'zh/en', type: 'phMismatch', detail: `zh[${zp}] en[${ep}]` })
      if (!z.length && !e.length) out.push({ key: k, locale: 'zh/en', type: 'emptyValue', detail: '' })
    }
    if (Array.isArray(z) || Array.isArray(e)) {
      if (!Array.isArray(z) || !Array.isArray(e)) out.push({ key: k, locale: 'zh/en', type: 'arrayMismatch', detail: '一侧数组一侧标量' })
      else if (z.length !== e.length) out.push({ key: k, locale: 'zh/en', type: 'arrayMismatch', detail: `长度 zh=${z.length} en=${e.length}` })
    }
    for (const [name, val] of [['zh', z], ['en', e]]) {
      for (const s of Array.isArray(val) ? val : [val]) {
        if (typeof s !== 'string') continue
        const bare = s.replace(/\{'@'\}/g, '')
        if (bare.includes('@')) {
          for (const l of bare.matchAll(/@(?:\.[a-zA-Z]+)?:([a-zA-Z0-9_.]+)/g)) {
            if (!keys.has(l[1])) out.push({ key: k, locale: name, type: 'brokenLink', detail: l[1] })
          }
          if (bare.replace(/@(?:\.[a-zA-Z]+)?:[a-zA-Z0-9_.]+/g, '').includes('@')) {
            out.push({ key: k, locale: name, type: 'bareAt', detail: s.slice(0, 60) })
          }
        }
        if (s.replace(PH, '').includes('|')) out.push({ key: k, locale: name, type: 'pipe', detail: s.slice(0, 60) })
      }
    }
  }
  return out
}

// 全树扫描「点分字面量」i18n 键（含动态引用：存在对象/数组/变量里的 label:'ns.x.y' 等
// 模式 E，非 t() 直接调用）。报告 locale 里不存在的。剥注释；过滤域名/代码路径等假阳性。
const LIT_RE = /['"`]([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)['"`]/g
export function danglingKeyLiterals() {
  const zh = loadJson('../src/locales/zh.json')
  const keys = new Set(flat(zh))
  const nsTop = new Set(Object.keys(zh))
  const out = []
  const seen = new Set()
  for (const f of walk('src')) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    const state = { inBlock: false, inHtml: false }
    lines.forEach((raw, i) => {
      const code = stripComments(raw, state)
      let m; LIT_RE.lastIndex = 0
      while ((m = LIT_RE.exec(code))) {
        const key = m[1]
        if (!nsTop.has(key.split('.')[0])) continue                       // 只认已知命名空间
        if (keys.has(key)) continue                                       // 已存在
        if (/\.(io|com|org|net|dev|ai|co)$/.test(key)) continue           // 域名(monitoring.coreos.com 等)
        if (/^(route|router|store|\$route)\./.test(key)) continue         // 代码属性路径
        if (/params|query\./.test(key)) continue
        const id = `${key}@${f}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ key, file: f, line: i + 1 })
      }
    })
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src']
  let files = []
  for (const r of roots) files.push(...(fs.statSync(r).isDirectory() ? walk(r) : [r]))
  let total = 0
  for (const f of files) {
    const h = scanSource(f)
    if (h.length) {
      total += h.length
      console.log(`\n${f}  (${h.length})`)
      h.forEach(x => console.log(`  ${x.line}: ${x.text}`))
    }
  }
  const { onlyZh, onlyEn } = parity()
  console.log(`\n残存中文行：${total}`)
  if (onlyZh.length || onlyEn.length) {
    console.log(`键不对齐：onlyZh=${onlyZh.length} onlyEn=${onlyEn.length}`, { onlyZh, onlyEn })
  } else {
    console.log('键对齐：✓')
  }
  const missing = missingKeys()
  const missingUnique = new Set(missing.map(m => m.key))
  console.log(`引用键缺失（会渲染为原始路径）：${missingUnique.size}`)
  if (missing.length) {
    const byKey = {}
    for (const m of missing) (byKey[m.key] ||= []).push(`${m.file.replace(/^src\//, '')}:${m.line}`)
    for (const k of Object.keys(byKey).sort()) console.log(`  ${k}  <-  ${byKey[k].slice(0, 3).join(', ')}`)
  }
  const dangling = danglingKeyLiterals()
  const danglingUnique = new Set(dangling.map(d => d.key))
  console.log(`动态引用键缺失(对象/变量里的点分字面量)：${danglingUnique.size}`)
  if (dangling.length) {
    const byKey = {}
    for (const d of dangling) (byKey[d.key] ||= []).push(`${d.file.replace(/^src\//, '')}:${d.line}`)
    for (const k of Object.keys(byKey).sort()) console.log(`  ${k}  <-  ${byKey[k].slice(0, 3).join(', ')}`)
  }
  const dups = duplicateKeys()
  console.log(`重复键(JSON.parse 静默丢前者)：${dups.length}`)
  if (dups.length) dups.forEach(d => console.log(`  ${d.path}  <-  ${d.file.replace(/^.*locales\//, '')}:${d.line}`))
  const issues = valueIssues()
  const issueTypes = [...new Set(issues.map(v => v.type))]
  console.log(`值级语法问题(占位符/裸@/复数|/断链/双空/数组错位)：${issues.length}`)
  for (const t of issueTypes) {
    const list = issues.filter(v => v.type === t)
    console.log(`  [${t}] ${list.length}`)
    list.slice(0, 10).forEach(v => console.log(`    ${v.key}(${v.locale}) ${v.detail}`))
  }
  process.exit(total > 0 || onlyZh.length || onlyEn.length || missing.length || dangling.length || dups.length || issues.length ? 1 : 0)
}
