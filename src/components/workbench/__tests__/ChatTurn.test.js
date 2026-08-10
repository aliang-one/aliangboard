import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChatTurn from '../ChatTurn.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { workbench: { chat: { roleYou: '你', roleAgent: 'Agent' } } } } })

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
