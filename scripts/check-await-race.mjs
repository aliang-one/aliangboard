// await-race 检测器(确定性,非启发式):
// 找出 <script setup> 里【同一 handler】内「未 await 的 store.(add|delete|update|remove)X(」
// 且该 handler 还调用了 queryClient.invalidateQueries / invalidateResource —— 即 Vue Query 迁移
// 遗留的 race(invalidate 抢在远端 apply 前触发 → 列表空/删除不消/编辑不回显)。
//
// 用法:
//   node scripts/check-await-race.mjs          # 打印违规清单(退出码:有违规=1)
//   node scripts/check-await-race.mjs --quiet  # 仅退出码(供 CI/测试门)
//
// 例外(不算违规):
//   - `await store.X(` / `const r = await store.X(` / `return store.X(`(返回 promise 给调用方)
//   - 模板里的 @click="store.X(...)"(inline,非 script handler;store 内部 invalidateResource 自洽)
//   - .forEach/.map/.then 回调里的批量调用(单独形态,另行处理)
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MUTATION = /\bstore\.(add|delete|update|remove)[A-Z]\w*\s*\(/
const INVALIDATE = /\b(queryClient\.invalidateQueries|invalidateResource)\s*\(/
const QUIET = process.argv.includes('--quiet')

// 枚举 src 下所有 .vue(git ls-files,避免 node_modules/dist)
let files
try { files = execSync('git ls-files "src/**/*.vue"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean) }
catch { files = [] }
if (!files.length) {
  const { readdirSync, statSync } = await import('node:fs')
  const walk = d => readdirSync(d).flatMap(f => { const p = d + '/' + f; return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.vue') ? [p] : []) })
  files = walk('src')
}

// 把 script setup 内容切成顶层 handler(粗略:按行,以 `async function`/`function`/`const X = (` 起,括号配平到闭合)
function extractHandlers(script) {
  const lines = script.split('\n')
  const handlers = []
  const startRe = /^(\s*)(export\s+)?(async\s+)?(function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*[{]?/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(startRe)
    if (!m) continue
    // 括号配平找函数体结束
    let depth = 0, started = false, end = i
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true }
        else if (ch === '}') depth--
      }
      if (started && depth === 0) { end = j; break }
    }
    handlers.push({ name: m[5] || m[6] || '?', body: lines.slice(i, end + 1) })
    i = end
  }
  return handlers
}

const violations = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!m) continue
  const handlers = extractHandlers(m[1])
  for (const h of handlers) {
    if (!INVALIDATE.test(h.body.join('\n'))) continue        // 该 handler 无 invalidate → 不是 race
    h.body.forEach((line, idx) => {
      if (line.includes('@click')) return                     // 模板行(理论上 script body 里不会有,防御)
      const mm = line.match(MUTATION)
      if (!mm) return
      // 例外:await / return / 批量回调
      if (/\bawait\b/.test(line) || /\breturn\b/.test(line)) return
      if (/\.(forEach|map|then|catch)\s*\(/.test(line)) return
      violations.push(`${file}  ${h.name}()  ← ${line.trim()}`)
    })
  }
}

if (!QUIET) {
  if (violations.length) {
    console.error(`❌ 发现 ${violations.length} 处 await-race(未 await 的 store 变更 + 同 handler invalidate):\n`)
    violations.forEach(v => console.error('  ' + v))
  } else {
    console.log('✓ 无 await-race:所有 store 变更(handler 内带 invalidate 的)均已 await')
  }
}
process.exit(violations.length ? 1 : 0)
