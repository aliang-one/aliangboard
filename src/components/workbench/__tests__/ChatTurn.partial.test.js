// P0-2(2026-09-06「对话尾巴不展示」修复):error 态保留已流出的部分回答。
// 症状实证:流式文本区 v-if=isStreaming,status 翻 error 当场消失——用户眼看着答案流到 90%
// 然后蒸发,只剩红错误块。契约:error+有已流出文本 → 部分文本(带标签)与错误块同屏;
// 无文本 → 只显错误块;done/thinking → 不显示 partial 标签。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChatTurn from '../ChatTurn.vue'

const i18n = createI18n({
  legacy: false, locale: 'zh',
  messages: { zh: { workbench: { chat: {
    roleAgent: 'Agent', roleYou: '你', partialAnswer: '已生成的部分回答(可能不完整):',
    cutByLength: '已达模型输出长度上限,以上回答被截断',
    stepsTaken: '{n} 步', thinking: '思考中',
  } } } },
})

const mountTurn = (turn) => mount(ChatTurn, {
  props: { turn: { role: 'assistant', reasoning: '', trace: [], steps: 0, truncated: false, ...turn } },
  global: { plugins: [i18n] },
})

test('error 态:已流出文本(带标签)与错误块同屏', async () => {
  const w = mountTurn({ status: 'error', content: '这是已经流出来的尾巴', error: 'LLM HTTP 502: boom' })
  await w.vm.$nextTick()
  expect(w.text()).toContain('这是已经流出来的尾巴')
  expect(w.text()).toContain('已生成的部分回答')
  expect(w.text()).toContain('LLM HTTP 502: boom')
})

test('error 态无已流出文本 → 只显错误块,不出 partial 区', () => {
  const w = mountTurn({ status: 'error', content: '', error: 'boom' })
  expect(w.text()).toContain('boom')
  expect(w.text()).not.toContain('已生成的部分回答')
})

test('done/thinking 态不出 partial 标签', () => {
  const done = mountTurn({ status: 'done', content: '完整回答', trace: [] })
  expect(done.text()).not.toContain('已生成的部分回答')
  const thinking = mountTurn({ status: 'thinking', content: '流式中', trace: [] })
  expect(thinking.text()).not.toContain('已生成的部分回答')
})

test('cutByLength 亮标(输出上限截断不再静默)', () => {
  const w = mountTurn({ status: 'done', content: '被掐断的回答', cutByLength: true, trace: [{ type: 'assistant', content: '被掐断的回答' }] })
  expect(w.text()).toContain('输出长度上限')
})
