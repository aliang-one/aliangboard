// 终端生命周期静态守卫(2026-09-05 方案 P1):registry 已退役,销毁语义只允许出现在
// TerminalService(terminal-service.mjs)。任何新增清理点绕过 service 直接操作会话 Map /
// channel close,都会让「旧 channel 延迟 close 误删新会话」一类事故复活——违例即红。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'server'
const ALLOWED = /terminal-service\.mjs$/
const BANNED = [
  /createTerminalRegistry/,
  /from ['"].*terminal-sessions\.mjs['"]/,
  /sshTerminals\./,
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'bin' && name !== 'terminfo') yield* walk(p) }
    else if (p.endsWith('.mjs') && !p.includes('.test.')) yield p
  }
}

test('terminal-guard:registry 语义仅存在于 TerminalService', () => {
  const violations = []
  for (const file of walk(ROOT)) {
    if (ALLOWED.test(file)) continue
    const src = readFileSync(file, 'utf8')
    for (const re of BANNED) if (re.test(src)) violations.push(`${file}: ${re}`)
  }
  assert.deepEqual(violations, [])
})
