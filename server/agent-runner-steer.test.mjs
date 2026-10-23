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
