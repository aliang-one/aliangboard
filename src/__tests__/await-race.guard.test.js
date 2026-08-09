// await-race 回归守门:跑 scripts/check-await-race.mjs,有违规则失败。
// 守的是「Vue Query 迁移遗留」race —— handler 内未 await 的 store 变更 + 紧跟 invalidate,
// 会导致 invalidate 抢在远端 apply 前触发 → 列表空/删除不消/编辑不回显。
// 这是确定性检测(非挂载套件那种启发式),CRUD 工厂化前/后都靠它防回归。
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

test('无 await-race:handler 内 store 变更(带 invalidate 的)均已 await', () => {
  let exitCode = 0
  let out = ''
  try {
    out = execFileSync('node', [resolve('scripts/check-await-race.mjs'), '--quiet'], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    exitCode = e.status ?? 1
    out = (e.stdout || '') + (e.stderr || '')
  }
  expect(exitCode, `await-race 检测发现违规(未 await 的 store 变更 + 同 handler invalidate):\n${out}`).toBe(0)
})
