import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { k8sSystemPrompt } from './k8s-prompt.mjs'

test('read 档:只读诊断,不含高危工具', () => {
  const p = k8sSystemPrompt('read')
  assert.ok(p.includes('debug 助手'))
  assert.ok(!p.includes('exec_pod'))
  assert.ok(!p.includes('delete_resource'))
})

test('operator 档:含 scale/restart,不含 admin 高危工具', () => {
  const p = k8sSystemPrompt('operator')
  assert.ok(p.includes('scale') || p.includes('restart'))
  assert.ok(!p.includes('exec_pod'))
})

test('admin 档:教 5 个高危工具 + 谨慎原则', () => {
  const p = k8sSystemPrompt('admin')
  for (const t of ['exec_pod', 'kubectl_debug', 'update_image', 'rollout_undo', 'delete_resource']) {
    assert.ok(p.includes(t), `admin prompt 应提及 ${t}`)
  }
  assert.ok(p.includes('仅在用户明确要求') || p.includes('最小代价'))
})
