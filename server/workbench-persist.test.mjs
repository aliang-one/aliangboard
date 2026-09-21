// persistableTrace:read_credential 块 password 明文洗指纹、plaintext 键摘除;text 值与非本工具块
// 不动;不 mutate 入参;非数组直通。(2026-09-20 spec §6:明文只活在当轮运行内存。)
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { persistableTrace, persistableMessages } from './workbench-persist.mjs'

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
