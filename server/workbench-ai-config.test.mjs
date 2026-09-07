// 工作台 AI 定制配置(单一来源,2026-08-25 设计):platform_settings 四键(additionalInstructions/disabledTools/projectMemory/maxSteps)+ 垃圾值兜底。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { getWorkbenchAiConfig, validateDisabledTools, clampInstructions, getMaxStepsConfig, validateMaxSteps,
  getMaxRunningConversationsConfig, validateMaxRunningConversations,
  getMaxConversationsPerProjectConfig, validateMaxConversationsPerProject } from './workbench-ai-config.mjs'

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

// ===== 最大执行步数(2026-09-03):0=不限制;缺键/垃圾 → env WB_MAX_STEPS → 16 =====
test('getMaxStepsConfig:缺键走 env 通道,env 语义与原 WB_MAX_STEPS 逐字一致', () => {
  assert.equal(getMaxStepsConfig(makeDb(), ''), 16, "Number('')=0→16;显式空串,避免读真实 process.env.WB_MAX_STEPS")
  assert.equal(getMaxStepsConfig(makeDb(), '32'), 32)
  assert.equal(getMaxStepsConfig(makeDb(), 'abc'), 16)
  assert.equal(getMaxStepsConfig(makeDb(), '0'), 16, 'env 0 回落默认(原语义 0||16)')
})

test('getMaxStepsConfig:落库值优先于 env;0=不限制;垃圾/越界/非整数回 env 链', () => {
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '30' }), '16'), 30)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '0' }), '16'), 0)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': 'abc' }), '16'), 16)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '999' }), '16'), 16)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '2.5' }), '16'), 16)
})

test('validateMaxSteps:null=不改;0..200 整数过;非整数/越界拒', () => {
  assert.deepEqual(validateMaxSteps(null), { ok: true, value: null })
  assert.deepEqual(validateMaxSteps(undefined), { ok: true, value: null })
  assert.equal(validateMaxSteps(0).ok, true)
  assert.equal(validateMaxSteps(0).value, 0)
  assert.equal(validateMaxSteps('30').ok, true)
  assert.equal(validateMaxSteps('30').value, 30)
  assert.equal(validateMaxSteps(201).ok, false)
  assert.equal(validateMaxSteps(-1).ok, false)
  assert.equal(validateMaxSteps(2.5).ok, false)
  assert.equal(validateMaxSteps('abc').ok, false)
})

// ===== 对话限额(2026-09-07 审计 F6):并发默认 5(0..20)、每项目默认 50(0..500);0=不限制 =====
// 语义逐字同 maxSteps:落库值(范围内整数)优先 → env(WB_CONV_MAX_RUNNING_PER_USER /
// WB_CONV_MAX_PER_PROJECT,env 0/垃圾回默认——0=不限制仅经落库值表达)→ 默认。
test('getMaxRunningConversationsConfig:缺键走 env 通道;env 0/垃圾回默认 5', () => {
  assert.equal(getMaxRunningConversationsConfig(makeDb(), ''), 5)
  assert.equal(getMaxRunningConversationsConfig(makeDb(), '8'), 8)
  assert.equal(getMaxRunningConversationsConfig(makeDb(), '20'), 20)
  assert.equal(getMaxRunningConversationsConfig(makeDb(), 'abc'), 5)
  assert.equal(getMaxRunningConversationsConfig(makeDb(), '0'), 5, 'env 0 回落默认(与 maxSteps env 语义逐字一致)')
})

test('getMaxRunningConversationsConfig:落库值优先于 env;0=不限制;垃圾/越界/非整数回 env 链', () => {
  assert.equal(getMaxRunningConversationsConfig(makeDb({ 'workbench.maxRunningConversations': '7' }), '5'), 7)
  assert.equal(getMaxRunningConversationsConfig(makeDb({ 'workbench.maxRunningConversations': '0' }), '5'), 0)
  assert.equal(getMaxRunningConversationsConfig(makeDb({ 'workbench.maxRunningConversations': 'abc' }), '5'), 5)
  assert.equal(getMaxRunningConversationsConfig(makeDb({ 'workbench.maxRunningConversations': '21' }), '5'), 5)
  assert.equal(getMaxRunningConversationsConfig(makeDb({ 'workbench.maxRunningConversations': '2.5' }), '5'), 5)
})

test('validateMaxRunningConversations:null=不改;0..20 整数过;非整数/越界拒', () => {
  assert.deepEqual(validateMaxRunningConversations(null), { ok: true, value: null })
  assert.deepEqual(validateMaxRunningConversations(undefined), { ok: true, value: null })
  assert.equal(validateMaxRunningConversations(0).ok, true)
  assert.equal(validateMaxRunningConversations(0).value, 0)
  assert.equal(validateMaxRunningConversations('8').ok, true)
  assert.equal(validateMaxRunningConversations('8').value, 8)
  assert.equal(validateMaxRunningConversations(20).ok, true)
  assert.equal(validateMaxRunningConversations(21).ok, false)
  assert.equal(validateMaxRunningConversations(-1).ok, false)
  assert.equal(validateMaxRunningConversations(2.5).ok, false)
  assert.equal(validateMaxRunningConversations('abc').ok, false)
})

test('getMaxConversationsPerProjectConfig:env 通道/落库优先/0=不限制/越界回链(默认 50)', () => {
  assert.equal(getMaxConversationsPerProjectConfig(makeDb(), ''), 50)
  assert.equal(getMaxConversationsPerProjectConfig(makeDb(), '80'), 80)
  assert.equal(getMaxConversationsPerProjectConfig(makeDb(), '0'), 50, 'env 0 回落默认')
  assert.equal(getMaxConversationsPerProjectConfig(makeDb(), 'abc'), 50)
  assert.equal(getMaxConversationsPerProjectConfig(makeDb({ 'workbench.maxConversationsPerProject': '100' }), '80'), 100)
  assert.equal(getMaxConversationsPerProjectConfig(makeDb({ 'workbench.maxConversationsPerProject': '0' }), '80'), 0)
  assert.equal(getMaxConversationsPerProjectConfig(makeDb({ 'workbench.maxConversationsPerProject': '501' }), '80'), 80)
  assert.equal(getMaxConversationsPerProjectConfig(makeDb({ 'workbench.maxConversationsPerProject': '1.5' }), '80'), 80)
})

test('validateMaxConversationsPerProject:null=不改;0..500 整数过;非整数/越界拒', () => {
  assert.deepEqual(validateMaxConversationsPerProject(null), { ok: true, value: null })
  assert.deepEqual(validateMaxConversationsPerProject(undefined), { ok: true, value: null })
  assert.equal(validateMaxConversationsPerProject(0).ok, true)
  assert.equal(validateMaxConversationsPerProject(0).value, 0)
  assert.equal(validateMaxConversationsPerProject(500).ok, true)
  assert.equal(validateMaxConversationsPerProject('100').value, 100)
  assert.equal(validateMaxConversationsPerProject(501).ok, false)
  assert.equal(validateMaxConversationsPerProject(-1).ok, false)
  assert.equal(validateMaxConversationsPerProject(1.5).ok, false)
  assert.equal(validateMaxConversationsPerProject('abc').ok, false)
})
