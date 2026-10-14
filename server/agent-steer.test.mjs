// pollSteer 钩子(spec D2,2026-10-13):每轮 chat 前吸收运行中补充;收尾轮同样吸收;
// 注入计入 trim 预算(注入发生在 trimMessages 之前)。缺省时零行为差异。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAgent } from './agent.mjs'

function tc(id, name) { return { role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: '{}' } }] } }

test('pollSteer:工具轮后注入,第二次 chat 的 messages 尾部含补充', async () => {
  const chats = []
  let pending = []
  const agent = createAgent({
    chat: async (messages) => {
      chats.push(messages.map(m => `${m.role}:${String(m.content).slice(0, 6)}`))
      return chats.length === 1 ? tc('t1', 'noop') : { role: 'assistant', content: '终答' }
    },
    toolDefs: [], execTool: async () => { pending = [{ role: 'user', content: '补充X' }]; return 'ok' },
    pollSteer: async () => { const r = pending; pending = []; return r },
  })
  const out = await agent.run({ system: 'sys', history: [{ role: 'user', content: '问' }] })
  assert.equal(out.content, '终答')
  assert.ok(chats[1].includes('user:补充X'))            // 第二次 chat 吸收
  const idxSteer = chats[1].lastIndexOf('user:补充X')
  const idxTool = chats[1].lastIndexOf('tool:ok')
  assert.ok(idxTool < idxSteer)                          // 注入在 tool 结果之后(数组尾部)
})

test('pollSteer:步数上限收尾轮同样吸收(Review Focus #1)', async () => {
  const chats = []
  let pending = []
  const agent = createAgent({
    chat: async (messages) => { chats.push(messages.map(m => `${m.role}:${String(m.content).slice(0, 6)}`)); return tc('t1', 'noop') },
    toolDefs: [], execTool: async () => { pending = [{ role: 'user', content: '收尾补充' }]; return 'ok' },
    maxSteps: 1,
    pollSteer: async () => { const r = pending; pending = []; return r },
  })
  const out = await agent.run({ system: 'sys', history: [{ role: 'user', content: '问' }] })
  assert.equal(out.truncated, true)
  const lastChat = chats[chats.length - 1]
  assert.ok(lastChat.includes('user:收尾补充'))          // 收尾轮 chat 前已注入
})

test('pollSteer 缺省:零行为差异(向后兼容)', async () => {
  const agent = createAgent({ chat: async () => ({ role: 'assistant', content: '答' }), toolDefs: [], execTool: async () => 'ok' })
  const out = await agent.run({ system: 's', history: [{ role: 'user', content: 'q' }] })
  assert.equal(out.content, '答')
})
