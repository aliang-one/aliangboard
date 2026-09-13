// server/credentials-routes-gates.test.mjs
// 进程内 handler 测试(照 workbench-projects-gates.test.mjs):stub deps 收 sent + 内存库断言。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { createCredentialsSchema } from './credentials-store.mjs'
import { createCredentialsRoutes } from './routes/credentials.mjs'

const KEY = randomBytes(32)

function makeHarness({ role = 'admin', db: dbArg, credCryptKey = KEY } = {}) {
  const sent = []
  const db = dbArg || (() => { const d = new DatabaseSync(':memory:'); createCredentialsSchema(d); return d })()
  const audits = []
  const routes = createCredentialsRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body,
    // 非 admin 返 null 前先 push 403——镜像真实 requireAdmin 的行为(它自发响应,handler 只短路)
    requireAdmin: () => (role === 'admin' ? { userId: 'u1', role, username: 'u1' } : (sent.push({ status: 403, json: {} }), null)),
    writeAudit: (_db, a) => audits.push(a),
    credCryptKey,
    getLlmConfig: () => harness._llmCfg,
    createLlmClient: cfg => { harness._llmClientCfg = cfg; return { chat: async () => ({ content: JSON.stringify(harness._llmReply ?? {}) }) } },
  })
  const harness = { sent, db, audits, _body: {}, _llmCfg: { baseURL: '', model: '' }, _llmReply: null,
    call: (m, p, body) => { harness._body = body || {}; return routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) } }
  return harness
}

test('非 admin 一律 403(鉴权层已发响应,handler 短路)', async () => {
  const h = makeHarness({ role: 'user' })
  assert.equal(await h.call('GET', '/api/workbench/credentials'), true)
  assert.equal(h.sent[0].status, 403)
})

test('POST 创建 → GET 列表 sanitize;GET :id text 明文/password 指纹', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials', { name: 'gh', fields: [
    { key: 'user', type: 'text', value: 'liang' }, { key: 'token', type: 'password', value: 'ghp_secret' }] })
  assert.equal(h.sent[0].status, 200)
  const id = h.sent[0].json.credential.id
  await h.call('GET', '/api/workbench/credentials')
  assert.deepEqual(h.sent[1].json.credentials[0].fields, [{ key: 'user', type: 'text' }, { key: 'token', type: 'password' }])
  await h.call('GET', `/api/workbench/credentials/${id}`)
  const det = h.sent[2].json.credential.fields
  assert.equal(det[0].value, 'liang', 'text 明文')
  assert.match(det[1].value, /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/, 'password 指纹')
  assert.ok(JSON.stringify(h.sent[2].json).indexOf('ghp_secret') < 0, '明文不外泄')
})

test('reveal 单字段 + 审计三连(create/reveal/delete)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials', { name: 'gh', fields: [{ key: 'token', type: 'password', value: 'x' }] })
  const id = h.sent[0].json.credential.id
  await h.call('POST', `/api/workbench/credentials/${id}/reveal`, { fieldKey: 'token' })
  assert.equal(h.sent[1].json.value, 'x')
  await h.call('POST', `/api/workbench/credentials/${id}/reveal`, { fieldKey: 'nope' })
  assert.equal(h.sent[2].status, 404)
  await h.call('DELETE', `/api/workbench/credentials/${id}`, { confirmName: 'wrong' })
  assert.equal(h.sent[3].status, 400)
  await h.call('DELETE', `/api/workbench/credentials/${id}`, { confirmName: 'gh' })
  assert.equal(h.sent[4].status, 200)
  assert.deepEqual(h.audits.map(a => a.tool), ['credential_create', 'credential_reveal', 'credential_delete'])
})

test('PATCH 校验失败与 404', async () => {
  const h = makeHarness()
  await h.call('PATCH', '/api/workbench/credentials/nope', { name: 'x' })
  assert.equal(h.sent[0].status, 404)
  await h.call('POST', '/api/workbench/credentials', { name: 'gh', fields: [] })
  const id = h.sent[1].json.credential.id
  await h.call('PATCH', `/api/workbench/credentials/${id}`, { fields: [{ key: 'a', type: 'text', value: '*** (1 chars, #abcd1234)' }] })
  assert.equal(h.sent[2].status, 400, '掩码回写拒绝')
})

// Task 2 review 携带项:PATCH fields 非数组须 400(防非数组值静默清空全部字段),而非透传 store 层变 [] 全删
test('PATCH fields 非数组 → 400(形状护栏,字段袋不被静默清空)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials', { name: 'gh', fields: [{ key: 'a', type: 'text', value: 'v1' }] })
  const id = h.sent[0].json.credential.id
  await h.call('PATCH', `/api/workbench/credentials/${id}`, { fields: 'not-an-array' })
  assert.equal(h.sent[1].status, 400)
  assert.equal(h.db.prepare('SELECT fields FROM workbench_credentials WHERE id=?').get(id).fields.includes('"a"'), true, '原字段仍在,未被清空')
})

test('parse:LLM 未配置 503;ok 路径回草稿;审计不记原文', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials/parse', { text: 'root 密码 abc' })
  assert.equal(h.sent[0].status, 503)   // 未配置
  h._llmCfg = { baseURL: 'http://x', model: 'm' }
  h._llmReply = { name: 'n', fields: [{ key: 'pwd', type: 'password', value: 'abc' }] }
  await h.call('POST', '/api/workbench/credentials/parse', { text: 'root 密码 abc' })
  assert.equal(h.sent[1].status, 200)
  assert.equal(h.sent[1].json.draft.fields[0].type, 'password')
  assert.equal(h._llmClientCfg.temperature, 0, 'temperature 覆写:防对话向参数泄漏进解析任务')
  const pa = h.audits.find(a => a.tool === 'credential_parse')
  assert.ok(pa && !pa.requestSummary.includes('abc'), '审计不记原文值')
})

test('parse:原文超 64KB → 400(LLM 已配置仍拒,不进模型)', async () => {
  const h = makeHarness()
  h._llmCfg = { baseURL: 'http://x', model: 'm' }
  await h.call('POST', '/api/workbench/credentials/parse', { text: 'x'.repeat(70000) })
  assert.equal(h.sent[0].status, 400)
})

test('解密失败(错钥)→ GET /:id 与 reveal 均 409 + wcred.decryptFailed 文案', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials', { name: 'gh', fields: [
    { key: 'user', type: 'text', value: 'liang' }, { key: 'token', type: 'password', value: 'ghp_secret' }] })
  const id = h.sent[0].json.credential.id
  // 同一库、不同 credCryptKey 重建路由:reveal 走 materializeField catch,GET /:id 走 detailView catch 映射
  const wrong = makeHarness({ db: h.db, credCryptKey: randomBytes(32) })
  await wrong.call('GET', `/api/workbench/credentials/${id}`)
  assert.equal(wrong.sent[0].status, 409)
  assert.equal(wrong.sent[0].json.message, '解密失败,请重新录入该凭据')
  await wrong.call('POST', `/api/workbench/credentials/${id}/reveal`, { fieldKey: 'token' })
  assert.equal(wrong.sent[1].status, 409)
  assert.equal(wrong.sent[1].json.message, '解密失败,请重新录入该凭据')
})

test('空值字段归一:GET :id text 回空串/password 回 0 字符指纹(不露 null)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials', { name: 'e', fields: [
    { key: 'note', type: 'text', value: '' }, { key: 'pwd', type: 'password', value: '' }] })
  const id = h.sent[0].json.credential.id
  await h.call('GET', `/api/workbench/credentials/${id}`)
  const det = h.sent[1].json.credential.fields
  assert.equal(det[0].value, '', 'text 空值归一为空串')
  assert.equal(det[1].value, '*** (0 chars, #da39a3ee)', 'password 空值=sha1 空串指纹,truthful')
})

// v2 Task 4:grants 子端点(POST 授权/DELETE 收回/GET :id 带 grants)+ 审计留痕。
// approve remember 的进程内测试属 conversations 路由——闭环由 Task 6 e2e 覆盖,gates 只测 grants 面。
test('grants 端点:POST 授权/DELETE 收回/GET :id 带 grants/审计', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/credentials', { name: 'gh', fields: [
    { key: 'base_url', type: 'text', value: 'https://x' }, { key: 'api_token', type: 'password', value: 't' }] })
  const id = h.sent[0].json.credential.id
  await h.call('POST', `/api/workbench/credentials/${id}/grants`, { adapter: 'http_request' })
  assert.equal(h.sent[1].status, 200)
  await h.call('POST', `/api/workbench/credentials/${id}/grants`, { adapter: 'banana' })
  assert.equal(h.sent[2].status, 400, '未实装适配器拒绝')
  await h.call('GET', `/api/workbench/credentials/${id}`)
  assert.deepEqual(h.sent[3].json.credential.grants.map(g => g.adapter), ['http_request'])
  await h.call('DELETE', `/api/workbench/credentials/${id}/grants/http_request`)
  assert.equal(h.sent[4].status, 200)
  await h.call('GET', `/api/workbench/credentials/${id}`)
  assert.deepEqual(h.sent[5].json.credential.grants, [])
  assert.ok(h.audits.some(a => a.tool === 'credential_grant_create') && h.audits.some(a => a.tool === 'credential_grant_revoke'))
})
