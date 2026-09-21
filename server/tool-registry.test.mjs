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

// ═══ 2026-09-20 spec §7:cred: 注入接线(三工具)与 wb_ssh_run 拒收 ═══
test('注入接线:substitute→原执行(物化命令)→scrubDeep 回传洗;失败即拒不执行', async () => {
  const calls = []
  const sub = { ok: true, text: 'echo MATERIALIZED', refs: [{ name: 'r' }], scrub: s => s.split('MATERIALIZED').join('***MASK***') }
  const mkCtx = () => ({
    creds: { substitute: c => { calls.push(['sub', c]); return sub } },
    wb: { execInPod: async a => { calls.push(['exec', a.command]); return { stdout: 'out MATERIALIZED' } } },
    ssh: { exec: async a => { calls.push(['ssh', a.command]); return { stdout: 'x MATERIALIZED' } } },
    apiKeyTools: { callTool: async (k, c, n, a) => { calls.push(['k8s', n, a.command]); return { stdout: 'y MATERIALIZED' } } },
  })
  for (const [tool, lane] of [['wb_exec', 'exec'], ['wb_ssh_exec', 'ssh'], ['exec_pod', 'k8s']]) {
    calls.length = 0
    const r = await registry.get(tool).exec(mkCtx(), { namespace: 'n', pod: 'p', server: 's', command: 'echo {{cred:r#password}}' })
    assert.deepEqual(calls.map(c => c[0]), ['sub', lane], `${tool}:先物化再走原执行面`)
    assert.equal(calls[0][1], 'echo {{cred:r#password}}', 'substitute 收到占位符版(审计消费 args 同源)')
    assert.ok(!JSON.stringify(r).includes('MATERIALIZED') && JSON.stringify(r).includes('***MASK***'), `${tool}:回传已洗`)
  }
  // substitute 失败:只有 substitute 被调,命令不执行
  calls.length = 0
  const failCtx = mkCtx(); failCtx.creds = { substitute: c => { calls.push(['sub', c]); return { ok: false, error: '未找到该凭据' } } }
  const r2 = await registry.get('wb_exec').exec(failCtx, { command: '{{cred:nope#x}}' })
  assert.deepEqual(r2, { error: '未找到该凭据' })
  assert.equal(calls.length, 1, 'fail-closed:原执行面未被调')
})

test('无桥/无占位符零开销直通;wb_ssh_run 拒占位符', async () => {
  const r = await registry.get('wb_exec').exec({ wb: { execInPod: async a => ({ stdout: a.command }) } }, { command: 'plain ls' })
  assert.equal(r.stdout, 'plain ls', '无 creds 桥字面直通(API-key 面)')
  const r3 = await registry.get('wb_ssh_run').exec({ sshJobs: { run: async () => ({ jobId: 'j' }) } }, { server: 's', command: 'x {{cred:r#password}}' })
  assert.match(r3.error, /暂不支持/, 'wb_ssh_run v1 不支持注入(spec §3 延期面,显式拒)')
  const r4 = await registry.get('wb_ssh_run').exec({ sshJobs: { run: async a => ({ jobId: 'j', cmd: a.command }) } }, { server: 's', command: 'plain' })
  assert.equal(r4.cmd, 'plain', '无占位符不受影响')
})
