// 自研零依赖 i18n 检查器：扫「残存用户可见中文」+ zh/en 键对齐。
// 用法： node scripts/i18n-check.mjs [paths...]   （默认 src）
// 残存>0 或键不对齐时退出码 1。排除：注释、console.*、locales/mock/__tests__/*.test.*。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  process.exit(total > 0 || onlyZh.length || onlyEn.length ? 1 : 0)
}
