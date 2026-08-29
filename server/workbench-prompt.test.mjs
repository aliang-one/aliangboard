// buildWorkbenchSystemPrompt 三段式拼装(2026-08-25 AI 定制设计):
// ①固定段(方法论,不可配)②工具文档段(promptHint 自动生成,disabled 过滤)③追加指令段。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildWorkbenchSystemPrompt } from './workbench-prompt.mjs'
import { registry } from './tool-registry.mjs'

test('默认拼装:固定段 + 只读/需人审两组工具文档;无追加段', () => {
  const p = buildWorkbenchSystemPrompt()
  assert.ok(p.includes('先调查,再行动'), '固定段方法论在')
  assert.ok(p.includes('## 只读工具'))
  assert.ok(p.includes('## 需人审工具'))
  assert.ok(p.includes('**wb_describe_resource**'))
  assert.ok(p.includes('**wb_exec**'))
  assert.ok(!p.includes('管理员追加指令'), '无追加指令时不出现③段标题')
})

test('disabledTools:被禁工具从②段消失,其余仍在;接受 Set', () => {
  const arr = buildWorkbenchSystemPrompt({ disabledTools: ['wb_exec', 'wb_scale'] })
  assert.ok(!arr.includes('**wb_exec**') && !arr.includes('**wb_scale**'))
  assert.ok(arr.includes('**wb_restart**'))
  const set = buildWorkbenchSystemPrompt({ disabledTools: new Set(['wb_exec']) })
  assert.ok(!set.includes('**wb_exec**'))
})

test('additionalInstructions:以「管理员追加指令」段拼在末尾', () => {
  const p = buildWorkbenchSystemPrompt({ additionalInstructions: '生产 ns 变更需先列受影响工作负载' })
  assert.ok(p.indexOf('## 管理员追加指令') > p.indexOf('## 规则'), '追加段在固定段之后')
  assert.ok(p.trimEnd().endsWith('生产 ns 变更需先列受影响工作负载'))
})

test('全禁用:两组标题仍在、条目为空,不抛', () => {
  const all = registry.workbenchTools().map(t => t.name)
  const p = buildWorkbenchSystemPrompt({ disabledTools: all })
  assert.ok(p.includes('## 只读工具'))
  assert.ok(!p.includes('**wb_exec**'))
})

test('registry.workbenchToolDefs(disabled):过滤 + 未知名忽略 + 无参兼容', () => {
  const all = registry.workbenchToolDefs().map(t => t.function.name)
  const filtered = registry.workbenchToolDefs(['wb_exec', 'bogus_name']).map(t => t.function.name)
  assert.ok(!filtered.includes('wb_exec') && !filtered.includes('bogus_name'))
  assert.equal(filtered.length, all.length - 1)
  assert.deepEqual(registry.workbenchToolDefs().map(t => t.function.name), all)
})

test('registry.workbenchTools():23 个 WB 工具,每个带 promptHint', () => {
  const tools = registry.workbenchTools()
  assert.equal(tools.length, 23)
  assert.ok(tools.every(t => typeof t.promptHint === 'string' && t.promptHint.length > 0))
  assert.ok(tools.some(t => t.name === 'wb_exec' && t.requiresApproval === true))
})

test('sshServers 注入:非空清单出现 id/名称/集群/凭据不可见指引;空清单不出现该段', () => {
  const withList = buildWorkbenchSystemPrompt({ sshServers: [{ id: 'abc', name: 'prod-web', description: 'web 节点', clusterRef: 'prod' }] })
  assert.ok(withList.includes('## 可管理的 SSH 服务器'))
  assert.ok(withList.includes('prod-web') && withList.includes('abc') && withList.includes('prod'))
  assert.ok(withList.includes('wb_ssh_exec'))
  assert.ok(withList.includes('不可见'))
  assert.ok(withList.includes('read_server_ledger'))   // 台账指引进提示词
  assert.ok(withList.includes('write_server_notes'))
  const without = buildWorkbenchSystemPrompt({})
  assert.ok(!without.includes('可管理的 SSH 服务器'))
})
