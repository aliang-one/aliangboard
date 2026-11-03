// llm-retry(makeChatWithRetry)单测:从 agent.mjs 闭包原样抽出的共享重试梯的等价性锁。
// 四条与 agent.test.mjs 既有重试用例同款写法(那边经 createAgent 全链,这边直击工厂);
// agent 主链等价性本身由 agent.test.mjs 零改动全绿保证,此处锁工厂裸契约。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { makeChatWithRetry } from './llm-retry.mjs'

const finalMsg = content => ({ role: 'assistant', content })
// 与 agent.test.mjs 同款测试缝:零延迟梯 + 假 sleep,失败路径不睡真实等待
const NO_WAIT = { retryDelays: [0, 0], sleepFn: async () => {} }

test('缺省梯:429 前 2 次失败、第 3 次成功 → 穿梯返回成功且共 3 次调用', async () => {
  let calls = 0
  const chat = async () => {
    calls++
    if (calls <= 2) { const e = new Error('LLM HTTP 429: 您的账户已达到速率限制'); e.status = 429; throw e }
    return finalMsg('限流间隙挤进去的终答')
  }
  const chatRetry = makeChatWithRetry({ chat, ...NO_WAIT })
  const out = await chatRetry([{ role: 'user', content: 'hi' }])
  assert.equal(out.content, '限流间隙挤进去的终答')
  assert.equal(calls, 3, '429 进退避梯:初始 + 2 次重试')
})

test('预算帽:梯名义总额超预算即截断 → 抛最后一次错误', async () => {
  let calls = 0
  const chat = async () => { calls++; const e = new Error(`LLM HTTP 503: unstable #${calls}`); e.status = 503; throw e }
  const chatRetry = makeChatWithRetry({ chat, retryDelays: [5000, 5000, 5000], retryBudgetMs: 6000, sleepFn: async () => {} })
  await assert.rejects(() => chatRetry([{ role: 'user', content: 'hi' }]), /#2/)
  assert.equal(calls, 2, '首笔 5000ms 在 6000 预算内;第二笔将超预算 → 不再重试')
})

test('取消类错误(CancelledError)→ 绝不重试', async () => {
  let calls = 0
  const chat = async () => {
    calls++
    const e = new Error('用户取消,中止工具执行'); e.name = 'CancelledError'; throw e
  }
  const chatRetry = makeChatWithRetry({ chat, ...NO_WAIT })
  await assert.rejects(() => chatRetry([{ role: 'user', content: 'hi' }]), /用户取消/)
  assert.equal(calls, 1, '取消类不重试')
})

test('已吐 delta(sawDelta)后失败 → 立即抛出不再重试', async () => {
  let calls = 0
  const chat = async (_messages, _tools, opts = {}) => {
    calls++
    if (calls === 1) { const e = new Error('LLM HTTP 503: unstable'); e.status = 503; throw e }
    opts.onDelta?.('重试轮已流出')
    throw new Error('midstream dead')
  }
  const chatRetry = makeChatWithRetry({ chat, ...NO_WAIT })
  await assert.rejects(
    () => chatRetry([{ role: 'user', content: 'hi' }], [], { onDelta: () => {} }),
    /midstream dead/,
  )
  assert.equal(calls, 2, '重试轮吐过 delta:不再发起下一次重试')
})

// ---- 梯耗尽错误信息增强(issue#20 诊断批:「错误信息也很少」——耗尽文案只有一行裸 503,无重试次数/原因/建议)----
test('梯耗尽:503 文案带重试次数/原因/建议,原错误身份(status)保留', async () => {
  let calls = 0
  const chat = async () => { calls++; const e = new Error('LLM HTTP 503: Service temporarily unavailable'); e.status = 503; throw e }
  const chatRetry = makeChatWithRetry({ chat, retryDelays: [0, 0], sleepFn: async () => {} })
  await assert.rejects(() => chatRetry([{ role: 'user', content: 'hi' }]), e => {
    assert.match(e.message, /Service temporarily unavailable/, '原文案保留(下游/既有断言兼容)')
    assert.match(e.message, /已自动重试 2 次/)
    assert.match(e.message, /上游持续不可用/)
    assert.match(e.message, /稍后再试/)
    assert.equal(e.status, 503, 'status 契约不变')
    assert.equal(e.name, 'Error')
    return true
  })
  assert.equal(calls, 3, '初始 + 2 次重试')
})

test('梯耗尽:429 文案标注 上游持续限流', async () => {
  const chat = async () => { const e = new Error('LLM HTTP 429: rate limited'); e.status = 429; throw e }
  const chatRetry = makeChatWithRetry({ chat, retryDelays: [0], sleepFn: async () => {} })
  await assert.rejects(() => chatRetry([{ role: 'user', content: 'hi' }]), /上游持续限流/)
})

test('client 类 4xx:单次立即重试路径,耗尽文案不加缀(原文案已明确)', async () => {
  let calls = 0
  const chat = async () => { calls++; const e = new Error('LLM HTTP 400: bad request'); e.status = 400; throw e }
  const chatRetry = makeChatWithRetry({ chat, retryDelays: [0, 0], sleepFn: async () => {} })
  await assert.rejects(() => chatRetry([{ role: 'user', content: 'hi' }]), e => {
    assert.equal(e.message, 'LLM HTTP 400: bad request')
    assert.equal(calls, 2, '单次立即重试')
    return true
  })
})
