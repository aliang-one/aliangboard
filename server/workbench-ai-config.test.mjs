// 工作台 AI 定制配置(单一来源,2026-08-25 设计):platform_settings 两键 + 垃圾值兜底。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { getWorkbenchAiConfig, validateDisabledTools, clampInstructions } from './workbench-ai-config.mjs'

function makeDb(settings = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )')
  for (const [k, v] of Object.entries(settings)) db.prepare('INSERT INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(k, String(v), Date.now())
  return db
}

test('缺键回默认:空追加 + 空禁用名单', () => {
  assert.deepEqual(getWorkbenchAiConfig(makeDb()), { additionalInstructions: '', disabledTools: [], projectMemory: true })
})

test('disabledTools:垃圾 JSON/非数组/未成名兜底;重复去重', () => {
  assert.deepEqual(getWorkbenchAiConfig(makeDb({ 'workbench.disabledTools': '{oops' })).disabledTools, [])
  assert.deepEqual(getWorkbenchAiConfig(makeDb({ 'workbench.disabledTools': '"nope"' })).disabledTools, [])
  assert.deepEqual(
    getWorkbenchAiConfig(makeDb({ 'workbench.disabledTools': JSON.stringify(['wb_exec', 'wb_exec', 'not_a_tool']) })).disabledTools,
    ['wb_exec'],
  )
})

test('additionalInstructions:读出并截断到 4000', () => {
  const cfg = getWorkbenchAiConfig(makeDb({ 'workbench.additionalInstructions': 'x'.repeat(5000) }))
  assert.equal(cfg.additionalInstructions.length, 4000)
})

test('validateDisabledTools:null/合法/非数组/未成名', () => {
  assert.deepEqual(validateDisabledTools(null), { ok: true, value: [] })
  const v = validateDisabledTools(['wb_exec', 'wb_exec'])
  assert.equal(v.ok, true); assert.deepEqual(v.value, ['wb_exec'])
  assert.deepEqual(validateDisabledTools('wb_exec'), { ok: false, detail: { type: 'notArray' } })
  assert.deepEqual(validateDisabledTools(['nope']), { ok: false, detail: { type: 'unknown', name: 'nope' } })
})

test('clampInstructions:截断 4000 + 非字符串安全', () => {
  assert.equal(clampInstructions('a'.repeat(5000)).length, 4000)
  assert.equal(clampInstructions(null), '')
})

// ── 项目记忆 T2:projectMemory 开关(默认 true;写 false;垃圾值兜底 true) ──
test('projectMemory:默认 true;"false" 读回 false;垃圾值兜底 true', () => {
  assert.equal(getWorkbenchAiConfig(makeDb()).projectMemory, true)
  assert.equal(getWorkbenchAiConfig(makeDb({ 'workbench.projectMemory': 'false' })).projectMemory, false)
  assert.equal(getWorkbenchAiConfig(makeDb({ 'workbench.projectMemory': 'true' })).projectMemory, true)
  assert.equal(getWorkbenchAiConfig(makeDb({ 'workbench.projectMemory': 'junk' })).projectMemory, true)
})
