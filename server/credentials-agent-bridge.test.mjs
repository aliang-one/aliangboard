// 凭据桥:引用解析三态/not-found 不泄露存在性/password 指纹/text 明文/ref 协议。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { createCredentialsSchema, createCredential, listPromptCredentials, grantCredentialUse } from './credentials-store.mjs'
import { createCredentialsAgentBridge, containsCredRef, firstCredRefName } from './credentials/agent-bridge.mjs'
import { scrubDeep } from './secret-mask.mjs'
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

test('read():空值字段归一——text 回空串,password 回 0 字符指纹(不露 null)', async () => {
  const db = new DatabaseSync(':memory:')
  createCredentialsSchema(db)
  createCredential(db, KEY, { name: 'empty', exposeToAi: true, fields: [
    { key: 'note', type: 'text', value: '' }, { key: 'pwd', type: 'password', value: '' }] })
  const bridge = createCredentialsAgentBridge({ db, key: KEY })
  const r = await bridge.read({ credential: 'empty' })
  const byKey = Object.fromEntries(r.fields.map(f => [f.key, f]))
  assert.equal(byKey.note.value, '')
  assert.equal(byKey.pwd.value, '*** (0 chars, #da39a3ee)', '空串 sha1 指纹,truthful')
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
  // user/token 不匹配任何适配器(http_request 需 base_url+api_token/db_query 需 driver…),
  // 本夹具形态即「无匹配适配器」——锁定行尾标注,防 ✓ 匹配标记渲染回归为静默空串。
  assert.ok(sys.includes('(无匹配适配器)'))
})

test('runAdapter:解析失败拒;needsApproval:无grant人审/有grant+GET免审/写方法恒审/非适配器恒审', async () => {
  const db = new DatabaseSync(':memory:')
  createCredentialsSchema(db)
  createCredential(db, KEY, { name: 'gh', exposeToAi: true, fields: [
    { key: 'base_url', type: 'text', value: 'https://api.x.com' }, { key: 'api_token', type: 'password', value: 'ghp_s' }] })
  const bridge = createCredentialsAgentBridge({ db, key: KEY })

  const bad = await bridge.runAdapter('http_request', { credential: 'nope' })
  assert.match(bad.error, /未找到该凭据/)
  assert.equal(await bridge.needsApproval('http_request', { credential: 'gh' }), true, '无 grant 人审')
  const cid = db.prepare('SELECT id FROM workbench_credentials WHERE name=?').get('gh').id
  grantCredentialUse(db, cid, 'http_request', 'u1')
  assert.equal(await bridge.needsApproval('http_request', { credential: 'gh' }), false, 'grant+GET 免审')
  assert.equal(await bridge.needsApproval('http_request', { credential: 'gh', method: 'POST' }), true, '写方法恒人审')
  assert.equal(await bridge.needsApproval('read_credential', { credential: 'gh' }), true, '非适配器工具恒人审(不经本桥,routeDynamicApproval 分流前的兜底语义)')
})

// ═══ 2026-09-20 spec §6/§7:🔓明文通道 + cred: 注入协议 ═══
test('read():🔓 aiReadable password 回明文+plaintext 标记;无标志照旧指纹', async () => {
  const db = new DatabaseSync(':memory:')
  createCredentialsSchema(db)
  createCredential(db, KEY, { name: 'gh', exposeToAi: true, fields: [
    { key: 'user', type: 'text', value: 'octocat' },
    { key: 'token', type: 'password', value: 'ghp_plain_text', aiReadable: true },
    { key: 'secret', type: 'password', value: 'ghp_still_masked' }] })
  const bridge = createCredentialsAgentBridge({ db, key: KEY })
  const r = await bridge.read({ credential: 'gh' })
  const byKey = Object.fromEntries(r.fields.map(f => [f.key, f]))
  assert.equal(byKey.token.value, 'ghp_plain_text'); assert.equal(byKey.token.plaintext, true)
  assert.match(byKey.secret.value, /^\*\*\* \(\d+ chars, #/); assert.ok(byKey.secret.plaintext === undefined)
})

test('substitute():物化/往返双洗/重复占位符/fail-closed 三态/空值护栏', () => {
  const db = new DatabaseSync(':memory:')
  createCredentialsSchema(db)
  createCredential(db, KEY, { name: 'reg', exposeToAi: true, fields: [
    { key: 'user', type: 'text', value: 'ci-bot' }, { key: 'password', type: 'password', value: 'hunter2-' }] })
  createCredential(db, KEY, { name: 'hid', exposeToAi: false, fields: [{ key: 'password', type: 'password', value: 'x' }] })
  createCredential(db, KEY, { name: 'dup', exposeToAi: true, fields: [{ key: 'password', type: 'password', value: 'dup-one' }] })
  createCredential(db, KEY, { name: 'dup', exposeToAi: true, fields: [{ key: 'password', type: 'password', value: 'dup-two' }] })
  const bridge = createCredentialsAgentBridge({ db, key: KEY })
  const none = bridge.substitute('docker login -u ci-bot')
  assert.equal(none.ok, true); assert.equal(none.text, 'docker login -u ci-bot')
  assert.equal(none.scrub('abc'), 'abc'); assert.deepEqual(none.refs, [])
  const sub = bridge.substitute('echo {{cred:reg#password}} && user={{cred:reg#user}} pw2={{cred:reg#PASSWORD}}')
  assert.equal(sub.ok, true)
  assert.equal(sub.text, 'echo hunter2- && user=ci-bot pw2=hunter2-')
  assert.deepEqual(sub.refs.map(r => r.field), ['password', 'user', 'password'])
  const scrubbed = sub.scrub('stdout: hunter2- ok')
  assert.ok(!scrubbed.includes('hunter2-') && /\*\*\* \(\d+ chars, #/.test(scrubbed), '回传输出洗回指纹')
  assert.equal(bridge.substitute('x {{cred:nope#password}}').ok, false, 'not-found 拒')
  assert.equal(bridge.substitute('x {{cred:hid#password}}').ok, false, 'not-exposed 拒')
  assert.equal(bridge.substitute('x {{cred:reg#missing}}').ok, false, '字段缺失拒')
  const amb = bridge.substitute('{{cred:dup#password}}')
  assert.equal(amb.ok, false)
})

test('scrubDeep:深走嵌套对象字符串全洗,非字符串直通', () => {
  const scrub = s => s.split('hunter2-').join('***MASK***')
  const out = scrubDeep({ stdout: 'hunter2- ok', nested: { arr: ['hunter2-', 42, null] }, n: 7, b: false }, scrub)
  assert.equal(out.stdout, '***MASK*** ok')
  assert.equal(out.nested.arr[0], '***MASK***')
  assert.equal(out.nested.arr[1], 42); assert.equal(out.n, 7); assert.equal(out.b, false)
  assert.equal(scrubDeep('plain hunter2-', scrub), 'plain ***MASK***')
})

test('containsCredRef:字符串参数命中模式;非对象/无命中 false', () => {
  assert.equal(containsCredRef({ command: 'x {{cred:a#b}}' }), true)
  assert.equal(containsCredRef({ command: 'ls', path: '/x' }), false)
  assert.equal(containsCredRef(null), false); assert.equal(containsCredRef('str'), false)
})

// I1(2026-09-20 final review):审计归因取首个占位符的凭据名(wbAuditIntent 消费)。
test('firstCredRefName:首个含模式字符串参数的 NAME;无命中/非对象 null', () => {
  assert.equal(firstCredRefName({ namespace: 'default', pod: 'p', command: 'mysql -p{{cred:prod-db#password}} -e 1' }), 'prod-db')
  assert.equal(firstCredRefName({ a: 'plain', b: 'x {{cred: reg #f}}' }), 'reg', '名带空白 trim')
  assert.equal(firstCredRefName({ a: 'plain', b: '{{cred:x#y}}{{cred:z#w}}' }), 'x', '多占位符取首个')
  assert.equal(firstCredRefName({ command: 'ls' }), null)
  assert.equal(firstCredRefName(null), null); assert.equal(firstCredRefName('str'), null)
  // 形似但不成对({{cred: 开却在但无完整 #…}} 收口)→ containsCredRef 会 true,名字解析 null
  // → wbAuditIntent 兜底 Credential/unknown(在那侧测)
  assert.equal(firstCredRefName({ command: 'echo {{cred:broken' }), null)
})
