// pollSteer 接线回归(2026-10-22 审计):pollSteer 是 createAgent 的工厂级参数(spec D2,
// agent.mjs 循环读工厂闭包)。历史两断:①10-22 前唯一生产构造点 createAgentRunner 不收不转发;
// ②10-22 修复补了中段(runner 收参+透传),但装配点 workbench-agent 仍把闭包放进 run() 选项——
// agent.mjs run() 解构无 rest,选项形态被静默丢弃,生产恒死(该形态 10-23 才被发现,见
// workbench-agent.test steer 组装配断言)。本文件用真实 createAgentRunner 钉死「runner 中段
// 转发」这一跳;「装配点工厂参递达」由 workbench-agent.test 的 capturedRunnerArgs 断言钉死。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAgentRunner } from './agent-runner.mjs'

test('createAgentRunner 透传 pollSteer:真实装配下运行中补充进入 LLM messages', async () => {
  const chats = []
  let pending = [{ role: 'user', content: '补充X' }]
  const runner = createAgentRunner({
    llmClient: { chat: async ({ messages }) => { chats.push(messages); return { role: 'assistant', content: '终答' } } },
    pollSteer: async () => { const r = pending; pending = []; return r },
  })
  const out = await runner.run({ system: 'sys', history: [{ role: 'user', content: '问' }] })
  assert.equal(out.content, '终答')
  // 首轮 chat 前已吸收(agent 循环每轮 chat 前调 pollSteer)
  assert.ok(chats[0].some(m => m.role === 'user' && m.content === '补充X'),
    'pollSteer 返回的补充必须出现在 LLM messages 中(经真实 runner 装配)')
  assert.deepEqual(pending, []) // 被消费
})

// 出口边界(2026-11-16 活体事故:纯问答轮/终答流式期间的补发根本没被受理)——
// 循环顶部 pollSteer 只发生在「每轮 chat 前」;最后一轮 chat 无工具调用即 return,
// 之后不再有任何 poll → 这期间落库的 steered 行本轮永远无人消费(徽标恒不翻、AI 不理会,
// 直到用户下次手动发消息才随 buildHistory 进上下文)。修复语义:出口 poll 到未消费补充
// → 推入并继续本轮(下一轮 chat 自然应答;无新补充且无工具调用才真正结束)。
test('出口边界:终答期间到达的补充被出口 poll 吸收并继续本轮应答', async () => {
  const chats = []
  let pending = [] // run 开始时无补充(循环顶部首轮 poll 空)
  const runner = createAgentRunner({
    llmClient: { chat: async ({ messages }) => {
      chats.push(messages)
      if (chats.length === 1) {
        pending = [{ role: 'user', content: '运行中补充Y' }] // 第一轮 chat 期间用户补发
        return { role: 'assistant', content: '第一版终答(没看到补充)' } // 无工具调用 → 旧代码在此 return
      }
      return { role: 'assistant', content: '已按补充重答' }
    }},
    pollSteer: async () => { const r = pending; pending = []; return r },
  })
  const out = await runner.run({ system: 'sys', history: [{ role: 'user', content: '问' }] })
  assert.equal(chats.length, 2, '出口 poll 到未消费补充必须继续一轮 chat,不得就此收尾')
  assert.ok(chats[1].some(m => m.role === 'user' && m.content === '运行中补充Y'),
    '补发行必须进入第二轮 LLM messages')
  assert.equal(out.content, '已按补充重答')
  assert.deepEqual(pending, []) // 出口 poll 已消费,不残留
})

test('出口边界:出口 poll 无补充 → 照常收尾不空转', async () => {
  const chats = []
  const runner = createAgentRunner({
    llmClient: { chat: async ({ messages }) => { chats.push(messages); return { role: 'assistant', content: '终答' } } },
    pollSteer: async () => [],
  })
  const out = await runner.run({ system: 'sys', history: [{ role: 'user', content: '问' }] })
  assert.equal(chats.length, 1, '无补充时不得多打一轮 chat')
  assert.equal(out.content, '终答')
})
