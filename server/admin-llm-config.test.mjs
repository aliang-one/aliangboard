// admin LLM 配置路由:「上文大小(contextWindow)」字段 GET/PUT 契约(2026-10-23)。
// 最小 deps 注入(getSetting/setSetting 走内存 Map),只打 /api/admin/llm-config 两个端点。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness(initialSettings = {}) {
  const settings = new Map(Object.entries(initialSettings))
  const sent = []
  const body = { v: {} }
  const routes = createAdminRoutes({
    db: {},
    sendJson: (res, code, json) => sent.push({ code, json }),
    readBody: async () => body.v,
    requireAdmin: () => ({ username: 'admin' }),
    getSetting: k => (settings.has(k) ? settings.get(k) : ''),
    setSetting: (k, v) => settings.set(k, v),
  })
  return {
    settings,
    call: async (method, pathname, payload) => {
      if (payload !== undefined) body.v = payload
      await routes.handle({ method, headers: { 'accept-language': 'en' } }, {}, new URL(`http://x${pathname}`))
      return sent[sent.length - 1]
    },
  }
}

test('PUT contextWindow:"1M" → parse 归一落库数字字符串;其余字段照旧', async () => {
  const h = makeHarness()
  const r = await h.call('PUT', '/api/admin/llm-config', { baseURL: 'http://llm', model: 'mock-1', temperature: '0.2', maxTokens: '8192', contextWindow: '1M' })
  assert.equal(r.code, 200)
  assert.deepEqual(r.json, { ok: true })
  assert.equal(h.settings.get('llm.contextWindow'), '1000000')
  assert.equal(h.settings.get('llm.baseURL'), 'http://llm')
  assert.equal(h.settings.get('llm.temperature'), '0.2')
})

test('PUT contextWindow:"200k"/"131072" → 同款归一(大小写/裸数字)', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/llm-config', { contextWindow: '200k' })
  assert.equal(h.settings.get('llm.contextWindow'), '200000')
  await h.call('PUT', '/api/admin/llm-config', { contextWindow: '131072' })
  assert.equal(h.settings.get('llm.contextWindow'), '131072')
})

test('PUT contextWindow 空串 → 清除(回落模型名自动)', async () => {
  const h = makeHarness({ 'llm.contextWindow': '1000000' })
  await h.call('PUT', '/api/admin/llm-config', { contextWindow: '' })
  assert.equal(h.settings.get('llm.contextWindow'), '')
})

test("PUT contextWindow 非法 → 400 双语消息,不落库", async () => {
  const h = makeHarness()
  for (const bad of ['abc', '1T', '-5K', '101M', '0', '500']) { // '500':下界 1000 之外(防 budgetChars=0 被 runner falsy 回落)
    const r = await h.call('PUT', '/api/admin/llm-config', { contextWindow: bad })
    assert.equal(r.code, 400, `非法输入 ${bad} 应 400`)
    assert.match(r.json.message, /Invalid context window/, `${bad} 带英文消息`)
  }
  assert.equal(h.settings.has('llm.contextWindow'), false, '非法输入不落库')
})

test('GET:未配置 → contextWindow 空串 + effectiveWindow 按模型名推导', async () => {
  const h = makeHarness({ 'llm.model': 'qwen-max' })
  const r = await h.call('GET', '/api/admin/llm-config')
  assert.equal(r.code, 200)
  assert.equal(r.json.contextWindow, '')
  assert.equal(r.json.effectiveWindow, 128_000, 'qwen-max 模型推导 128k')
})

test('GET:已配置 → contextWindow 回显 + effectiveWindow=配置值(压过模型推导)', async () => {
  const h = makeHarness({ 'llm.model': 'qwen-max', 'llm.contextWindow': '1000000' })
  const r = await h.call('GET', '/api/admin/llm-config')
  assert.equal(r.json.contextWindow, '1000000')
  assert.equal(r.json.effectiveWindow, 1_000_000, '显式配置压过 qwen-max 的 128k')
})

test('GET:配置值非法(历史脏数据)→ effectiveWindow 走 parseWindowInput 同轨回落,不炸', async () => {
  const h = makeHarness({ 'llm.model': 'mock-1', 'llm.contextWindow': 'garbage' })
  const r = await h.call('GET', '/api/admin/llm-config')
  assert.equal(r.json.effectiveWindow, 200_000, 'mock-1 未命中表 → 默认 200k')
  // 单轨断言:GET 与运行时消费点同用 parseWindowInput——'1e6' 非合法输入形态(parse→null)
  // 必须回落模型推导,而不是 Number('1e6')=1e6 直通谎报「当前生效 1M」
  const h2 = makeHarness({ 'llm.model': 'mock-1', 'llm.contextWindow': '1e6' })
  const r2 = await h2.call('GET', '/api/admin/llm-config')
  assert.equal(r2.json.effectiveWindow, 200_000, 'Number() 直通会谎报 1M;parse 单轨回落 200k')
})
