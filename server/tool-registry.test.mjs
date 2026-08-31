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

// 2026-08-31 工具链审计修复⑦:wb 只读工具失败此前返回字符串(`查询失败: ...`),
// agent-runner 的 finalize 判 r?.error 判不到 → 审计链把失败记成 'ok'。统一改为与写工具
// 同形的 { error }(LLM 照样可读 JSON,审计保真)。
test('修复⑦:wb 只读工具失败统一返 { error } 对象(与写工具同形)', async () => {
  const READ_TOOLS = ['read_ledger', 'read_project_file', 'wb_list_resources', 'wb_get_pod_logs',
    'wb_describe_resource', 'wb_get_resource', 'wb_get_events', 'wb_rollout_status', 'wb_read_pod_file', 'wb_top']
  const boomWb = new Proxy({}, { get: () => async () => { throw new Error('boom') } })
  for (const name of READ_TOOLS) {
    const t = registry.get(name)
    assert.ok(t, `${name} 应在册`)
    const r = await t.exec({ wb: boomWb }, name === 'read_project_file' ? { path: 'x' } : {})
    assert.ok(r && typeof r === 'object' && typeof r.error === 'string', `${name} 失败应返 { error } 对象,收到: ${JSON.stringify(r)}`)
    assert.match(r.error, /boom/)
  }
})
