// persistableTrace:read_credential 块 password 明文洗指纹、plaintext 键摘除;text 值与非本工具块
// 不动;不 mutate 入参;非数组直通。(2026-09-20 spec §6:明文只活在当轮运行内存。)
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { persistableTrace } from './workbench-persist.mjs'

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
