// server/tool-registry.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { registry, workbenchExcludeTools, SSH_HIDDEN_TOOLS } from './tool-registry.mjs'

test('SSH 9 工具在册;新 5 工具审批位与 exec 挂载正确', () => {
  for (const n of SSH_HIDDEN_TOOLS) assert.ok(registry.get(n), `${n} 应在册`)
  assert.equal(registry.get('wb_ssh_run').requiresApproval, true)
  assert.equal(registry.get('wb_ssh_job_write').requiresApproval, true)
  assert.equal(registry.get('wb_ssh_job_out').requiresApproval, false)
  assert.equal(registry.get('wb_ssh_job_list').requiresApproval, false)
  assert.equal(registry.get('wb_ssh_job_kill').requiresApproval, false)
  assert.equal(typeof registry.get('wb_ssh_run').exec, 'function')
})

test('workbenchExcludeTools:零暴露隐藏全部 9 个;有暴露返回 null', () => {
  const ex = workbenchExcludeTools({ hasCluster: true, sshExposedCount: 0 })
  for (const n of SSH_HIDDEN_TOOLS) assert.ok(ex.has(n))
  assert.equal(workbenchExcludeTools({ hasCluster: true, sshExposedCount: 2 }), null)
})

test('SSH_HIDDEN_TOOLS 单一事实源导出(供 workbench-prompt 同源)', () => {
  assert.equal(Object.isFrozen(SSH_HIDDEN_TOOLS) || Array.isArray(SSH_HIDDEN_TOOLS), true)
  assert.ok(SSH_HIDDEN_TOOLS.includes('wb_ssh_run') && SSH_HIDDEN_TOOLS.includes('wb_ssh_job_kill'))
})
