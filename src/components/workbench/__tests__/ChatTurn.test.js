import { test, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChatTurn from '../ChatTurn.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { common: { copy: '复制' }, workbench: { chat: { roleYou: '你', roleAgent: 'Agent', regenerate: '重新生成', reasoningTitle: '思考过程', maxStepsReached: '已达到最大执行步数' } } } } })

test('ChatTurn: agent done 渲染 markdown(v-html)', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '**hi**' } }, global: { plugins: [i18n] } })
  expect(w.html()).toContain('<strong>hi</strong>')
})

test('ChatTurn: 用户轮有底色 + role label', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'user', content: 'hello' } }, global: { plugins: [i18n] } })
  expect(w.find('[data-role="user"]').exists()).toBe(true)
  expect(w.text()).toContain('你')
})

test('ChatTurn: agent done 暴露 language class(供 Prism)', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '```yaml\napiVersion: v1\n```' } }, global: { plugins: [i18n] } })
  expect(w.html()).toMatch(/class="language-yaml"/)
})

test('ChatTurn: error 状态显示 error 文案', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'error', error: 'boom' } }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('boom')
})

// dev28: P1 消息操作——复制按钮(hover)/重新生成 emit/代码块复制装饰
test('ChatTurn: done turn 渲染复制按钮;showRegenerate 时渲染重新生成并 emit', async () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '答案', trace: [], steps: 2 } }, global: { plugins: [i18n] } })
  expect(w.html()).toContain('content_copy')
  expect(w.find('[title="重新生成"]').exists()).toBe(false)
  const w2 = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '答案', trace: [], steps: 2 }, showRegenerate: true }, global: { plugins: [i18n] } })
  expect(w2.find('[title="重新生成"]').exists()).toBe(true)
  await w2.find('[title="重新生成"]').trigger('click')
  expect(w2.emitted('regenerate')).toHaveLength(1)
})

test('ChatTurn: done turn 围栏代码块被装饰出复制按钮(.code-copy)', async () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '示例:\n```yaml\napiVersion: v1\nkind: Pod\n```\n', trace: [], steps: 0 } }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.findAll('.code-copy').length).toBe(1)
  expect(w.find('.code-bar').text()).toContain('yaml')
})

// dev32: 思考过程折叠区——有 reasoning 渲染 details;thinking 态 open,done 收起
test('ChatTurn: reasoning 折叠区渲染,thinking 时展开/done 后收起', async () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'thinking', content: '', reasoning: '正在分析集群状态…', trace: [], steps: 0 } }, global: { plugins: [i18n] } })
  expect(w.html()).toContain('思考过程')
  expect(w.find('details').attributes('open')).toBeDefined()
  expect(w.text()).toContain('正在分析集群状态…')
  const w2 = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '答案', reasoning: '推理过程', trace: [], steps: 1 } }, global: { plugins: [i18n] } })
  expect(w2.find('details').attributes('open')).toBeUndefined()
})

// 2026-08-25 工具内联时间线:agent 轮里 chips 总览(ToolTrace)与时间线(ToolTimeline)并存;
// 时间线行点击进 ToolCallModal 详情。
test('agent 轮:chips 总览与时间线并存,时间线行可开详情 Modal', async () => {
  const turn = { _id: 1, role: 'assistant', status: 'done', content: '终答', reasoning: '', steps: 1,
    trace: [{ type: 'tool', name: 'wb_get_pod_logs', args: { pod: 'p1' }, result: { logs: 'log-line-1' }, ts: 1756100000000 }] }
  const w = mount(ChatTurn, { props: { turn }, global: { plugins: [i18n] } })
  // chips 总览仍在
  expect(w.findAll('button').some(b => b.text().includes('wb_get_pod_logs'))).toBe(true)
  // 时间线行存在且含预览
  const row = w.find('[data-testid="tool-tl-row"]')
  expect(row.exists()).toBe(true)
  expect(row.text()).toContain('log-line-1')
  await row.trigger('click')
  await flushPromises()
  // 本文件 i18n 极简(标题渲染为键名)→ 断言 modal 实质内容而非本地化标题
  expect(document.querySelector('[data-testid="tc-args"]')?.textContent).toContain('"pod": "p1"')
  expect(document.querySelector('[data-testid="tc-result"]')?.textContent).toContain('log-line-1')
})

// ── 交错渲染(2026-08-25):trace 含 assistant 文本 → 文本↔工具行按发生顺序;终答不重复;存量回退 ──
test('交错模式:文本↔工具行按发生顺序交错渲染,终答(末文本块)不与 content 重复', () => {
  const turn = { _id: 9, role: 'assistant', status: 'done', content: '最终结论', reasoning: '', steps: 2,
    trace: [
      { type: 'assistant', content: '我先看下日志。', ts: 1 },
      { type: 'tool', name: 'wb_get_pod_logs', args: {}, result: { logs: 'FATAL line' }, ts: 2 },
      { type: 'assistant', content: '密码认证失败,进容器确认。', ts: 3 },
      { type: 'tool', name: 'wb_exec', args: {}, result: { stdout: 'bin etc' }, ts: 4 },
      { type: 'assistant', content: '最终结论', ts: 5 },
    ] }
  const w = mount(ChatTurn, { props: { turn }, global: { plugins: [i18n] } })
  const flow = w.find('[data-testid="interleaved-flow"]')
  expect(flow.exists()).toBe(true)
  const html = flow.html()
  // 交错顺序:文本A → 工具行 → 文本B → 工具行 → 终答
  const iA = html.indexOf('我先看下日志。')
  const iTool1 = html.indexOf('wb_get_pod_logs')
  const iB = html.indexOf('密码认证失败,进容器确认。')
  const iTool2 = html.indexOf('wb_exec')
  const iFinal = html.indexOf('最终结论')
  expect([iA, iTool1, iB, iTool2, iFinal].every(i => i >= 0)).toBe(true)
  expect(iA).toBeLessThan(iTool1)
  expect(iTool1).toBeLessThan(iB)
  expect(iB).toBeLessThan(iTool2)
  expect(iTool2).toBeLessThan(iFinal)
  // 终答只出现一次(交错块内),旧 done 渲染通道让位
  expect(html.match(/最终结论/g)?.length).toBe(1)
  // 回退布局的时间线不在
  expect(w.find('[data-testid="tool-timeline"]').exists()).toBe(false)
})

test('交错模式:thinking 态当前轮流式文本作为流末段渲染', () => {
  const turn = { _id: 10, role: 'assistant', status: 'thinking', content: '正在生成的回答…', reasoning: '', steps: 1,
    trace: [
      { type: 'assistant', content: '先看日志。', ts: 1 },
      { type: 'tool', name: 'wb_get_pod_logs', args: {}, result: { logs: 'L1' }, ts: 2 },
    ] }
  const w = mount(ChatTurn, { props: { turn }, global: { plugins: [i18n] } })
  const flow = w.find('[data-testid="interleaved-flow"]')
  expect(flow.text()).toContain('先看日志。')
  expect(flow.text()).toContain('正在生成的回答…')
})

test('存量回退:trace 无 assistant 事件 → 时间线布局,终答走原通道', () => {
  const turn = { _id: 11, role: 'assistant', status: 'done', content: '终答', reasoning: '', steps: 1,
    trace: [{ type: 'tool', name: 'wb_get_pod_logs', args: {}, result: { logs: 'L' }, ts: 1 }] }
  const w = mount(ChatTurn, { props: { turn }, global: { plugins: [i18n] } })
  expect(w.find('[data-testid="interleaved-flow"]').exists()).toBe(false)
  expect(w.find('[data-testid="tool-timeline"]').exists()).toBe(true)
  expect(w.text()).toContain('终答')
})

// 2026-08-27 静默终止审计:truncated(done+步数用尽)此前只有角色行 ⚠ 小标,用户等数分钟
// 拿到一行灰字观感即"异常结束无提示"——锁定醒目警告块渲染。
test('ChatTurn: truncated 渲染醒目步数用尽警告块', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '(达到最大步数,未给出终答)', truncated: true } }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('已达到最大执行步数')
  expect(w.find('.text-status-warning').exists()).toBe(true)
})

// 2026-08-27 modal 审计:pending_approval 黄条是审批 modal 的重开入口(ESC 收起后不再自动重弹)
test('ChatTurn: pending_approval 黄条可点击,emit reopen-approval', async () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'pending_approval', content: '' } }, global: { plugins: [i18n] } })
  const bar = w.find('[data-testid="pending-approval-bar"]')
  expect(bar.exists()).toBe(true)
  await bar.trigger('click')
  expect(w.emitted('reopen-approval')).toHaveLength(1)
})
