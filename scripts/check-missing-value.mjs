// 「computed/ref 漏 .value」确定性检测器(非挂载套件那种启发式)。
//
// Vue <script setup> 里 computed/ref 不自动解包,用 X.filter / [...X] / for-of X / X.length /
// return X 必须写 .value,否则运行期崩(X.filter is not a function / X is not iterable)。
// 本检测器逐 .vue 扫 <script>,对每个 const X = computed|ref|shallowRef(...) 检查这些崩点。
//
// 关键防误报:
//   - 只扫 <script>(模板里 X 自动解包,正确)
//   - (?<![\w.]) 前置:X 不被单词字符或点前置 → 排除 obj.X(属性访问,如 workload.value.revisions)
//   - (?!\.value):X.value.method / [...X.value] / for of X.value 正确用法不报
//   - 跳过声明行与注释行
//
// 用法:node scripts/check-missing-value.mjs [--quiet]
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// 纯函数:传 <script> 文本,返回违规 [{line,name,kind,raw}]
export function findMissingValue(script) {
  const names = [...script.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:computed|ref|shallowRef|shallowComputed|toRef)\s*\(/g)]
    .map(m => m[1])
  const uniq = [...new Set(names)]
  const lines = script.split('\n')
  const METHOD = 'filter|map|find|forEach|reduce|reduceRight|some|every|sort|join|includes|indexOf|flat|flatMap|slice|concat|findIndex|findLast|entries|keys|values|at|forEach'
  const viol = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue
    for (const name of uniq) {
      if (new RegExp(`\\bconst\\s+${escapeRe(name)}\\s*=`).test(raw)) continue   // 声明行跳过
      const re = (pat) => new RegExp(pat)
      if (re(`(?<![\\w.])${escapeRe(name)}\\.(?:${METHOD})\\b`).test(raw)) viol.push({ line: i + 1, name, kind: 'method', raw: t })
      if (re(`(?<![\\w.])${escapeRe(name)}\\.length\\b`).test(raw)) viol.push({ line: i + 1, name, kind: 'length', raw: t })
      if (re(`\\[\\.\\.\\.${escapeRe(name)}\\]`).test(raw)) viol.push({ line: i + 1, name, kind: 'spread', raw: t })
      if (re(`\\bof\\s+${escapeRe(name)}(?!\\.value)\\b`).test(raw)) viol.push({ line: i + 1, name, kind: 'for-of', raw: t })
      if (re(`\\breturn\\s+${escapeRe(name)}(?![.\\w])`).test(raw)) viol.push({ line: i + 1, name, kind: 'return', raw: t })
    }
  }
  return viol
}

// CLI 仅在直接执行时跑(被 import 做单测时不跑,避免 process.exit 杀掉测试进程)
if (import.meta.url !== pathToFileURL(process.argv[1] || '').href) {
  // 被当作模块导入:什么都不做(只导出 findMissingValue)
} else {
const QUIET = process.argv.includes('--quiet')
let files
try { files = execSync('git ls-files "src/**/*.vue"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean) }
catch { files = [] }

const violations = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!m) continue
  for (const v of findMissingValue(m[1])) violations.push({ file, ...v })
}

if (!QUIET) {
  if (violations.length) {
    console.error(`❌ 发现 ${violations.length} 处 computed/ref 漏 .value:\n`)
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.name} (${v.kind})  ← ${v.raw}`)
  } else {
    console.log('✓ 无 computed/ref 漏 .value')
  }
}
process.exit(violations.length ? 1 : 0)
}
