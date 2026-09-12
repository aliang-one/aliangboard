// server/credential-parse.test.mjs
// 解析纯函数:mock llmClient(照 distill.test.mjs)。断言 prompt 组装/JSON 容错/从严归一/硬钳。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildCredentialParsePrompt, parseCredentialJson, runCredentialParse } from './credential-parse.mjs'

test('buildCredentialParsePrompt:system 带 JSON 契约与从严 type 指南;user 带原文', () => {
  const [sys, user] = buildCredentialParsePrompt('服务器 10.0.0.1 root 密码 abc123')
  assert.ok(sys.content.includes('JSON') && sys.content.includes('password'), '契约+从严指南')
  assert.ok(user.content.includes('10.0.0.1'))
})

test('parseCredentialJson:裸 JSON / ```json 围栏 / 前后杂文 三态', () => {
  const draft = { name: 'x', fields: [{ key: 'p', type: 'password', value: 'v' }] }
  assert.deepEqual(parseCredentialJson(JSON.stringify(draft)), draft)
  assert.deepEqual(parseCredentialJson('```json\n' + JSON.stringify(draft) + '\n```'), draft)
  assert.deepEqual(parseCredentialJson('好的,结果如下:\n```json\n' + JSON.stringify(draft) + '\n```\n以上。'), draft)
  assert.equal(parseCredentialJson('完全不是 JSON'), null)
  assert.equal(parseCredentialJson('{"broken": '), null)
})

test('runCredentialParse:ok 路径 type 归一 password;非法字段丢弃计数', async () => {
  const reply = { content: JSON.stringify({ name: 'ssh-1', description: 'd', tags: ['a'],
    fields: [
      { key: 'host', type: 'text', value: '10.0.0.1' },
      { key: 'pwd', type: 'secret', value: 'abc' },            // 未知 type → password(从严)
      { key: 'ok', type: 'text', value: 'x' }, { key: 'OK', type: 'text', value: 'y' },  // 重复 → 丢
    ] }) }
  const out = await runCredentialParse({ llmClient: { chat: async () => reply }, rawText: '原文' })
  assert.equal(out.ok, true)
  assert.equal(out.draft.name, 'ssh-1')
  const types = Object.fromEntries(out.draft.fields.map(f => [f.key, f.type]))
  assert.equal(types.pwd, 'password', '未知 type 从严归一')
  assert.ok(!out.draft.fields.some(f => f.key === 'OK'), '大小写重复丢弃')
  assert.equal(out.dropped, 1)
})

test('runCredentialParse:解析失败 → ok:false', async () => {
  const out = await runCredentialParse({ llmClient: { chat: async () => ({ content: '胡言乱语' }) }, rawText: 'x' })
  assert.deepEqual(out, { ok: false, error: 'parse-failed' })
})
