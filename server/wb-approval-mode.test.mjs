// 审批三档模式(2026-09-09 VSCode 风格设计):ask=完全现状(含 SSH 服务器策略放宽)/
// writes=写类自动放行、命令执行仍人审/auto=模式管辖工具全部放行。
// 组合规则:wb_ssh_* 工具恒由服务器策略裁决(aiApprovalPolicy 更严者胜),模式不放宽;
// write_server_notes 是平台台账写(非服务器命令),归模式管辖。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAgentRunner } from './agent-runner.mjs'
import { createAuditSchema } from './audit.mjs'
import { WB_APPROVAL_MODES, modeAutoPasses, readUserApprovalMode } from './wb-approval-mode.mjs'

function seqChat(messages) { let i = 0; return async () => messages[Math.min(i++, messages.length - 1)] }
const tc = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const fin = content => ({ role: 'assistant', content })

function makeUsersDb(prefs) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE platform_users ( id INTEGER PRIMARY KEY, username TEXT NOT NULL, prefs TEXT )')
  db.prepare('INSERT INTO platform_users (id, username, prefs) VALUES (1, ?, ?)').run('alice', prefs == null ? null : JSON.stringify(prefs))
  return db
}

// ── 纯函数:modeAutoPasses ────────────────────────────────────────────────────

test('ask 档:任何工具都不自动放行(完全现状)', () => {
  for (const n of ['write_project_file', 'apply_project_manifests', 'propose_learning', 'bootstrap_ledger',
    'wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo', 'wb_exec', 'write_server_notes',
    'wb_ssh_exec', 'wb_ssh_read_file', 'wb_ssh_run', 'wb_ssh_job_write']) {
    assert.equal(modeAutoPasses('ask', n), false, `ask 档 ${n} 不应自动放行`)
  }
})

test('writes 档:9 个写类自动放行,wb_exec 命令类仍人审', () => {
  for (const n of ['write_project_file', 'apply_project_manifests', 'propose_learning', 'bootstrap_ledger',
    'wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo', 'write_server_notes']) {
    assert.equal(modeAutoPasses('writes', n), true, `writes 档 ${n} 应自动放行`)
  }
  assert.equal(modeAutoPasses('writes', 'wb_exec'), false, 'writes 档 wb_exec(容器命令)仍人审')
})

test('SSH 工具恒不受模式放宽(服务器策略更严者胜)', () => {
  for (const m of ['writes', 'auto']) {
    for (const n of ['wb_ssh_exec', 'wb_ssh_read_file', 'wb_ssh_run', 'wb_ssh_job_write', 'wb_ssh_job_out']) {
      assert.equal(modeAutoPasses(m, n), false, `${m} 档 ${n} 应由服务器策略裁决,模式不放宽`)
    }
  }
})

test('auto 档:模式管辖的 10 个工具全放行', () => {
  for (const n of ['write_project_file', 'apply_project_manifests', 'propose_learning', 'bootstrap_ledger',
    'wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo', 'wb_exec', 'write_server_notes']) {
    assert.equal(modeAutoPasses('auto', n), true, `auto 档 ${n} 应自动放行`)
  }
})

test('fail-closed:未知模式/未成名工具一律不放行(防未来新审批工具被旧模式静默放行)', () => {
  assert.equal(modeAutoPasses('yolo', 'write_project_file'), false)
  assert.equal(modeAutoPasses(null, 'write_project_file'), false)
  assert.equal(modeAutoPasses('auto', 'not_a_tool'), false)
  assert.equal(modeAutoPasses('auto', ''), false)
  // 免审读类工具不在审批集,模式层不置言(恒 false,读类本就不经门)
  assert.equal(modeAutoPasses('auto', 'read_ledger'), false)
})

test('WB_APPROVAL_MODES 枚举(prefs 校验复用)', () => {
  assert.deepEqual(WB_APPROVAL_MODES, ['ask', 'writes', 'auto'])
})

// ── readUserApprovalMode:prefs 读取 + 兜底 ──────────────────────────────────

test('readUserApprovalMode:合法值透传;缺用户/缺键/垃圾值归一 ask', () => {
  assert.equal(readUserApprovalMode(makeUsersDb({ workbenchApprovalMode: 'auto' }), 1), 'auto')
  assert.equal(readUserApprovalMode(makeUsersDb({ workbenchApprovalMode: 'writes' }), 1), 'writes')
  assert.equal(readUserApprovalMode(makeUsersDb({}), 1), 'ask')
  assert.equal(readUserApprovalMode(makeUsersDb(null), 1), 'ask')
  assert.equal(readUserApprovalMode(makeUsersDb({ workbenchApprovalMode: 'yolo' }), 1), 'ask', '垃圾值 fail-closed')
  assert.equal(readUserApprovalMode(makeUsersDb({}), 999), 'ask', '用户不存在归 ask')
})

// ── runner 门:approvalMode 装配 ─────────────────────────────────────────────

test('runner:writes 档 write_project_file 直接执行,无 checkpoint', async () => {
  const writes = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async (p, c) => { writes.push({ p, c }) } }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'a.yaml', content: 'x' }), fin('已写')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, approvalMode: () => 'writes' })
  const out = await run({ history: [] })
  assert.equal(out.status, undefined, '不应挂起')
  assert.equal(out.content, '已写')
  assert.equal(writes.length, 1, '写已发生(免审直执行)')
})

test('runner:auto 档 wb_exec 放行;wb_ssh_exec 仍问 dynamicApproval(服务器策略)', async () => {
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {} }
  // wb_exec 经 K8s ctx 执行,这里只验证到门:改为用 dynamicApproval 桩观察询问路径
  const asked = []
  const dynamicApproval = async (n) => { asked.push(n); return true }
  const llmClient = { chat: seqChat([tc('1', 'wb_ssh_exec', { server: 's1', command: 'uptime' }), fin('ok')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, approvalMode: () => 'auto', dynamicApproval })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval', 'auto 档 SSH 工具仍按服务器策略人审(更严者胜)')
  assert.deepEqual(asked, ['wb_ssh_exec'], 'SSH 工具必须进 dynamicApproval 路由')
})

test('runner:ask 档(缺省 approvalMode)保持旧行为——write_project_file 仍 checkpoint', async () => {
  const writes = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async (p, c) => { writes.push(p) } }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'a.yaml', content: 'x' }), fin('已写')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  assert.deepEqual(writes, [])
})

// ── 审计标记:模式放行的执行行带 approval:auto ──────────────────────────────

function makeAuditDb() {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  return db
}

test('writes 档自动放行的执行:audit_log 行 requestSummary 带 approval:auto 标记', async () => {
  const db = makeAuditDb()
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => ({ ok: true }) }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'a.yaml', content: 'x'.repeat(300) }), fin('已写')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, audit: { db, owner: 'alice', clusterId: 'c1' }, approvalMode: () => 'writes' })
  await run({ history: [] })
  const rows = db.prepare("SELECT * FROM audit_log WHERE tool=? AND status='finalized'").all('write_project_file')
  assert.equal(rows.length, 1)
  assert.match(rows[0].requestSummary, /approval:auto$/, '标记在截断之后追加,长 args 不吞标记')
})

test('人审批准的执行:审计行无 approval:auto 标记', async () => {
  const db = makeAuditDb()
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => ({ ok: true }) }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'a.yaml', content: 'x' }), fin('已写')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, audit: { db, owner: 'alice', clusterId: 'c1' } })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  const rows = db.prepare("SELECT * FROM audit_log WHERE tool=? AND status='finalized'").all('write_project_file')
  assert.equal(rows.length, 1)
  assert.doesNotMatch(rows[0].requestSummary, /approval:auto/)
})
