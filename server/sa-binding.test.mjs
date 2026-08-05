// T6 测试:TokenRequest body 构造 + per-SA 缓存 + 单飞(requestFn 注入,无需真集群)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildTokenRequestBody, createSaBinding, MIN_TTL_SECONDS, _clearSaTokenCacheForTest } from './sa-binding.mjs'

function mockCallCtx(apiServer = 'https://10.0.0.1:6443') {
  return { apiServer: new URL(apiServer), authHeader: 'Bearer bootstrap', dispatcher: {} }
}
// 假 requestFn:返回带 token 的 body;可注入延迟 + 计数。
function mockRequestFn({ delay = 0, token = 'tok' } = {}) {
  let calls = 0
  const fn = async (callCtx, path, init) => {
    calls++
    if (delay) await new Promise(r => setTimeout(r, delay))
    assert.match(path, /\/serviceaccounts\/[^/]+\/token$/, '路径应为 .../serviceaccounts/<name>/token')
    assert.equal(init.method, 'POST')
    return { body: { status: { token: `${token}-${calls}`, expirationTimestamp: new Date(Date.now() + 600 * 1000).toISOString() } } }
  }
  fn.calls = () => calls
  return fn
}

// --- buildTokenRequestBody ---
test('buildTokenRequestBody: TTL 钳到下限 600s(<600 → 600);audience 给则数组', () => {
  const a = JSON.parse(buildTokenRequestBody({ audience: 'https://kubernetes.default.svc', expirationSeconds: 60 }))
  assert.equal(a.spec.expirationSeconds, MIN_TTL_SECONDS, '60s 被钳到 600')
  assert.deepEqual(a.spec.audiences, ['https://kubernetes.default.svc'])
  assert.equal(a.apiVersion, 'authentication.k8s.io/v1')
})
test('buildTokenRequestBody: 无 audience → 不含 audiences 字段(取 apiserver 默认)', () => {
  const a = JSON.parse(buildTokenRequestBody({}))
  assert.equal(a.spec.expirationSeconds, MIN_TTL_SECONDS)
  assert.ok(!('audiences' in a.spec))
})

// --- getSaToken 缓存 ---
test('getSaToken: 冷启动调 requestFn;复用窗口内不重复调(reuseFraction=1 → 立即复用)', async () => {
  _clearSaTokenCacheForTest()
  const rf = mockRequestFn()
  const getSaToken = createSaBinding({ requestFn: rf, audience: 'aud', reuseFraction: 1 })
  const t1 = await getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' })
  const t2 = await getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' })
  assert.equal(t1, t2, '窗口内复用同一 token')
  assert.equal(rf.calls(), 1, 'requestFn 只调一次(缓存命中)')
})

test('getSaToken: 超过复用窗口(reuseFraction=0 → 立即过期)→ 重新 mint', async () => {
  _clearSaTokenCacheForTest()
  const rf = mockRequestFn()
  const getSaToken = createSaBinding({ requestFn: rf, audience: 'aud', reuseFraction: 0 })
  const t1 = await getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' })
  const t2 = await getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' })
  assert.notEqual(t1, t2, '窗口外重新 mint,token 不同')
  assert.equal(rf.calls(), 2)
})

test('getSaToken: 不同 SA / 不同 cluster → 不同缓存项,各自 mint', async () => {
  _clearSaTokenCacheForTest()
  const rf = mockRequestFn({ reuseFraction: 1 } || {})
  const getSaToken = createSaBinding({ requestFn: rf, audience: 'aud', reuseFraction: 1 })
  await getSaToken(mockCallCtx('https://c1:6443'), { namespace: 'ns', name: 'sa1' })
  await getSaToken(mockCallCtx('https://c1:6443'), { namespace: 'ns', name: 'sa2' }) // 不同 SA
  await getSaToken(mockCallCtx('https://c2:6443'), { namespace: 'ns', name: 'sa1' }) // 不同 cluster
  assert.equal(rf.calls(), 3, '三个不同 sig 各 mint 一次')
})

// --- 单飞(codex #7):并发同 SA 只 mint 一次 ---
test('getSaToken: 并发同 SA → 单飞(requestFn 只调一次,两调用得同 token)', async () => {
  _clearSaTokenCacheForTest()
  const rf = mockRequestFn({ delay: 20 })  // 慢 mint,让两并发都落在 inflight 窗口
  const getSaToken = createSaBinding({ requestFn: rf, audience: 'aud', reuseFraction: 1 })
  const [a, b] = await Promise.all([
    getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' }),
    getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' }),
  ])
  assert.equal(a, b, '两并发得同一 token')
  assert.equal(rf.calls(), 1, '单飞:requestFn 只调一次')
})

// --- 错误:清 inflight,下次可重试 ---
test('getSaToken: mint 失败抛错且清 inflight(下次可重试)', async () => {
  _clearSaTokenCacheForTest()
  let fail = true
  const rf = async () => { if (fail) throw new Error('apiserver 403'); return { body: { status: { token: 'x' } } } }
  const getSaToken = createSaBinding({ requestFn: rf, audience: 'aud' })
  await assert.rejects(() => getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' }), /apiserver 403/)
  fail = false
  const t = await getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' }) // inflight 已清 → 可重试
  assert.equal(t, 'x')
})

test('getSaToken: 返回的 body 无 token → 抛清晰错误(提示 bootstrap 凭据/audience)', async () => {
  _clearSaTokenCacheForTest()
  const rf = async () => ({ body: { status: {} } }) // 无 token
  const getSaToken = createSaBinding({ requestFn: rf, audience: 'aud' })
  await assert.rejects(() => getSaToken(mockCallCtx(), { namespace: 'ns', name: 'sa' }), /未返回 token/)
})
