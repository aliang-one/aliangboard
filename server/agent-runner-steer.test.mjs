// pollSteer 接线回归(2026-10-22 审计):workbench-agent 把 pollSteer 闭包作为 run() 选项传入,
// 而 createAgentRunner 工厂签名不收、createAgent 调用不转发——pollSteer 是 createAgent 的工厂级
// 参数(spec D2,agent.mjs 循环读工厂闭包),run() 选项形态被静默忽略 → 生产装配下钩子恒
// undefined,运行中实时注入当轮从不生效、steer_consumed 永不广播。既有三份 steer 测试全绿
// 恰因桩掉 runner(workbench-agent.test 捕获 run 选项直调闭包)或直测工厂形态(agent-steer.test),
// 真实 runner→agent 装配零覆盖——本文件用真实 createAgentRunner 钉死该缝。
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
