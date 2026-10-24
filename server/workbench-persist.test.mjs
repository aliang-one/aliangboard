// persistableTrace:read_credential 块 password 明文洗指纹、plaintext 键摘除;text 值与非本工具块
// 不动;不 mutate 入参;非数组直通。(2026-09-20 spec §6:明文只活在当轮运行内存。)
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { persistableTrace, persistableMessages, scrubKnownDeep, scrubPendingApprovalDeep } from './workbench-persist.mjs'
import { rememberCredentialValue, resetCredentialValuesForTest } from './credential-known-values.mjs'

const PLAIN = 'ghp_plaintext_secret'
const readBlock = { type: 'tool', name: 'read_credential', args: { credential: 'gh' },
  result: { credential: 'gh', id: 'i1', fields: [
    { key: 'user', type: 'text', ref: 'cred:i1#user', value: 'octocat' },
    { key: 'token', type: 'password', ref: 'cred:i1#token', value: PLAIN, plaintext: true }] }, ts: 1 }

test('read_credential 块:password 明文洗指纹、plaintext 键摘除;text 值保留', () => {
  const out = persistableTrace([readBlock])
  const f = Object.fromEntries(out[0].result.fields.map(x => [x.key, x]))
  assert.match(f.token.value, /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/)
  assert.ok(f.token.plaintext === undefined)
  assert.equal(f.user.value, 'octocat', 'text 明文与普通对话同权,不洗')
})

test('其他工具块原样(注入值的输出洗在工具层 scrubDeep);不 mutate 入参;非数组直通', () => {
  const exec = { type: 'tool', name: 'wb_ssh_exec', args: { command: 'x' }, result: { stdout: PLAIN }, ts: 2 }
  const input = [readBlock, exec, { type: 'assistant', content: 'done' }]
  const snapshot = JSON.stringify(input)
  const out = persistableTrace(input)
  assert.equal(JSON.stringify(input), snapshot, '入参未被 mutate')
  assert.equal(out[1].result.stdout, PLAIN)
  assert.equal(out[2].content, 'done')
  assert.equal(persistableTrace(null), null)
})

// persistableMessages(fix round 1,spec §11 红线7「含 messages」):workbench_conversations.messages
// 列存的是 LLM 消息数组(agent.mjs:289 以 JSON 串把工具结果塞进 role:'tool' content),
// read_credential 的 password 明文须经 scrubReadResult 洗回指纹。非 JSON/无 fields 的 content
// 原串字节保留(不 round-trip,零格式扰动)。
test('persistableMessages:tool 消息内 read_credential 明文洗指纹;非 JSON/无 fields 原串保留;不 mutate;非数组直通', () => {
  const readJson = JSON.stringify({ credential: 'gh', id: 'i1', fields: [
    { key: 'user', type: 'text', ref: 'cred:i1#user', value: 'octocat' },
    { key: 'token', type: 'password', ref: 'cred:i1#token', value: PLAIN, plaintext: true }] })
  const nonJson = '用户拒绝了该操作(read_credential)'
  const noFields = '{"columns":["a","b"],"rows":[["1","2"]]}'
  const input = [
    { role: 'user', content: 'read gh' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_credential', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: readJson },
    { role: 'tool', tool_call_id: 'c2', content: nonJson },
    { role: 'tool', tool_call_id: 'c3', content: noFields },
    { role: 'assistant', content: 'done' },
  ]
  const snapshot = JSON.stringify(input)
  const out = persistableMessages(input)

  // (a) read_credential 结果 JSON → password 洗指纹、plaintext 键摘除;text 保留
  const back = JSON.parse(out[2].content)
  const f = Object.fromEntries(back.fields.map(x => [x.key, x]))
  assert.match(f.token.value, /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/)
  assert.ok(f.token.plaintext === undefined)
  assert.equal(f.user.value, 'octocat')

  // (b) 非 JSON 字符串 content → 字节不变;(c) JSON 但无 fields 数组 → 字节不变(不 round-trip)
  assert.equal(out[3].content, nonJson)
  assert.equal(out[4].content, noFields)

  // (d) 非 tool 消息原样;(e) 非数组直通;(f) 入参未 mutate
  assert.equal(out[5].content, 'done')
  assert.equal(persistableMessages(null), null)
  assert.equal(JSON.stringify(input), snapshot, '入参未被 mutate')
})

// ═══ 2026-10-24 凭据审计 P0-1:值级兜底洗(第二参 known)═══
// 结构化洗涤认「read_credential 结果块」形状;8192/32KB 截断钳制把 JSON 切成裸串后失明,
// 🔓明文随截断残留落库。known=当轮已知值集(credential-known-values 登记),对截断裸串按值洗。

const KNOWN = [{ value: PLAIN, mask: '*** (20 chars, #deadbeef)' }]

test('persistableTrace+known:截断裸串 result 里的明文按值洗(形状无关兜底)', () => {
  // 模拟 clampTraceStep 产物:read_credential 结果 JSON 被截成裸串(结构化洗涤对此原样返回)
  const truncatedJson = JSON.stringify({ credential: 'gh', id: 'i1', fields: [
    { key: 'token', type: 'password', ref: 'cred:i1#token', value: PLAIN, plaintext: true }] }).slice(0, 160)
  assert.ok(truncatedJson.includes(PLAIN), '前置条件:明文在截断窗口内(JSON 在值之后被切)')
  const block = { type: 'tool', name: 'read_credential', args: {}, result: truncatedJson, ts: 1 }
  const out = persistableTrace([block], KNOWN)
  assert.ok(!out[0].result.includes(PLAIN), '裸串明文必须被值级兜底洗掉')
  assert.match(out[0].result, /\*\*\* \(20 chars, #deadbeef\)/)
  // 未带 known 时维持旧行为(纯函数向后兼容,登记表不隐式耦合)
  assert.equal(persistableTrace([block])[0].result, truncatedJson)
})

test('persistableMessages+known:截断 tool content 裸串按值洗;text 值与非 tool 消息不洗', () => {
  const cut = `{"credential":"gh","fields":[{"key":"token","value":"${PLAIN.slice(0, 14)}` +
    `${PLAIN.slice(14)}","plaintext":true}],"m":"${'x'.repeat(200)}"}`.slice(0, 110)
  assert.ok(cut.includes(PLAIN), '前置条件:明文在截断窗口内')
  const input = [
    { role: 'tool', tool_call_id: 'c1', content: cut },
    { role: 'assistant', content: `复述 ${PLAIN}` },   // 正文复述:裁决 #2 与 text 同权,不洗
  ]
  const out = persistableMessages(input, KNOWN)
  assert.ok(!out[0].content.includes(PLAIN), 'tool content 裸串明文洗掉')
  assert.equal(out[1].content, `复述 ${PLAIN}`, '正文复述不洗(spec §14 显式残余)')
})

test('persistableTrace+known:结构化路径仍优先,known 是补充(整块可解析时双保险不冲突)', () => {
  const out = persistableTrace([readBlock], KNOWN)
  const f = Object.fromEntries(out[0].result.fields.map(x => [x.key, x]))
  assert.match(f.token.value, /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/)
  assert.equal(f.user.value, 'octocat', 'text 值不在登记集,不受兜底影响')
})

test('scrubKnownDeep:pending/queue 等任意对象按值洗(args 二次持久化面)', () => {
  const pending = { name: 'wb_exec', args: { command: `echo ${PLAIN} | docker login` } }
  const out = scrubKnownDeep(pending, KNOWN)
  assert.ok(!JSON.stringify(out).includes(PLAIN))
  assert.match(out.args.command, /\*\*\*/)
  assert.deepEqual(JSON.parse(JSON.stringify(pending)).args.command, `echo ${PLAIN} | docker login`, '入参未 mutate')
  assert.equal(scrubKnownDeep({ a: 1 }, KNOWN).a, 1)
})

// pendingApproval 专用:args 洗回占位符而非指纹——resume 按原 args 重新执行,占位符经
// substitute 重新物化(功能不破),落库无明文(红线 7 闭合)。指纹会把命令跑坏。
test('scrubPendingApprovalDeep:带溯源值洗回 {{cred:名#字段}} 占位符', () => {
  resetCredentialValuesForTest()
  rememberCredentialValue('ghp_pending_resume_value', 'gh#token')
  const pending = { name: 'wb_exec', args: { command: 'echo ghp_pending_resume_value | docker login' } }
  const out = scrubPendingApprovalDeep(pending)
  assert.ok(!JSON.stringify(out).includes('ghp_pending_resume_value'), '落库载荷无明文')
  assert.equal(out.args.command, 'echo {{cred:gh#token}} | docker login')
  assert.equal(out.name, 'wb_exec', '非字符串字段不动')
  // 无溯源值不洗占位符(洗了 resume 会拒执行),交由指纹兜底洗
  rememberCredentialValue('ghp_no_provenance_val')
  const p2 = { args: { command: 'use ghp_no_provenance_val' } }
  const out2 = scrubPendingApprovalDeep(p2)
  assert.match(out2.args.command, /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/, '无溯源值指纹兜底')
  resetCredentialValuesForTest()
})
