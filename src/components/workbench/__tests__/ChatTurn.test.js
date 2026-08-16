import { test, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChatTurn from '../ChatTurn.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { common: { copy: '复制' }, workbench: { chat: { roleYou: '你', roleAgent: 'Agent', regenerate: '重新生成', reasoningTitle: '思考过程' } } } } })

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
