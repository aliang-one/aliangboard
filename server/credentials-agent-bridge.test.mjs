// 凭据桥:引用解析三态/not-found 不泄露存在性/password 指纹/text 明文/ref 协议。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { createCredentialsSchema, createCredential, listPromptCredentials } from './credentials-store.mjs'
import { createCredentialsAgentBridge } from './credentials/agent-bridge.mjs'
import { buildWorkbenchSystemPrompt } from './workbench-prompt.mjs'

const KEY = randomBytes(32)
function makeBridge(expose = true) {
  const db = new DatabaseSync(':memory:')
  createCredentialsSchema(db)
  createCredential(db, KEY, { name: 'gh', exposeToAi: expose, fields: [
    { key: 'user', type: 'text', value: 'octocat' }, { key: 'token', type: 'password', value: 'ghp_x' }] })
  // 注:text 值用 'octocat' 而非 'liang':FIXED 提示词头部含产品名「aliangboard」,'liang' 是
  // 其子串,`!sys.includes('liang')` 恒假(brief 原稿碰撞,此处换值保持子串断言原强度。
  createCredential(db, KEY, { name: 'hidden', exposeToAi: false, fields: [{ key: 'k', type: 'text', value: 'v' }] })
  return { db, bridge: createCredentialsAgentBridge({ db, key: KEY }) }
}

test('list():只列暴露行,带 ref,零值', async () => {
  const { bridge } = makeBridge()
  const r = await bridge.list()
  assert.equal(r.credentials.length, 1)
  const c = r.credentials[0]
  assert.equal(c.name, 'gh'); assert.match(c.ref, /^cred:/)
  assert.deepEqual(c.fields, [{ key: 'user', type: 'text' }, { key: 'token', type: 'password' }])
  assert.ok(!JSON.stringify(r).includes('ghp_x'))
})

test('read():text 明文/password 指纹/带 ref;field 省略返回全部', async () => {
  const { bridge } = makeBridge()
  const r = await bridge.read({ credential: 'gh' })
  assert.equal(r.credential, 'gh')
  const byKey = Object.fromEntries(r.fields.map(f => [f.key, f]))
  assert.equal(byKey.user.value, 'octocat')
  assert.match(byKey.token.value, /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/)
  assert.match(byKey.token.ref, /^cred:[0-9a-f-]+#token$/)
  const one = await bridge.read({ credential: 'gh', field: 'TOKEN' })   // 大小写不敏感
  assert.equal(one.fields.length, 1); assert.equal(one.fields[0].key, 'token')
})

test('解析三态:not-found / not-exposed(不泄露存在) / id 优先', async () => {
  const { bridge, db } = makeBridge()
  const nf = await bridge.read({ credential: 'nope' })
  assert.match(nf.error, /未找到该凭据/)
  const ne = await bridge.read({ credential: 'hidden' })
  assert.match(ne.error, /未暴露给 AI/)
  const byId = await bridge.read({ credential: db.prepare('SELECT id FROM workbench_credentials WHERE name=?').get('gh').id })
  assert.equal(byId.credential, 'gh')
})

test('buildWorkbenchSystemPrompt:凭据清单段只有元数据', () => {
  const { db } = makeBridge()
  const sys = buildWorkbenchSystemPrompt({ sshServers: [], credentials: listPromptCredentials(db) })
  assert.ok(sys.includes('gh') && sys.includes('user(text)'), '清单含名称+字段结构')
  assert.ok(!sys.includes('ghp_x') && !sys.includes('octocat'), '值不进提示词')
  assert.ok(sys.includes('read_credential'))
})
