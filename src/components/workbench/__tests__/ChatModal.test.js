// ChatModal 契约:Modal 壳 + 内嵌 WorkbenchChat 且 props 正确传递;
// conversation 切换时 :key 重建;关闭事件透传。哑壳——不做 readAt/轮询。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const chatProps = vi.hoisted(() => [])
vi.mock('../WorkbenchChat.vue', () => ({
  default: {
    name: 'WorkbenchChat',
    props: ['projectId', 'projectName', 'conversationId', 'activeConversationId'],
    setup: p => { chatProps.push({ ...p }) },
    template: '<div data-testid="wb-chat" />',
  },
}))
vi.mock('@/components/common/Modal.vue', () => ({
  default: {
    name: 'Modal',
    props: ['modelValue', 'title', 'width'],
    emits: ['update:modelValue'],
    template: `<div v-if="modelValue" data-testid="modal"><h3>{{ title }}</h3><slot /></div>`,
  },
}))

import ChatModal from '../ChatModal.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: {} } })
const CONV = { id: 'c1', projectId: 'p1', projectName: '支付网关', title: '排查重启', status: 'running', updatedAt: 1 }

function mountModal(conv = CONV) {
  return mount(ChatModal, {
    props: { modelValue: true, conversation: conv },
    global: { plugins: [i18n] },
  })
}

test('打开时挂 WorkbenchChat,projectId/conversationId/activeConversationId 传递', () => {
  chatProps.length = 0
  const w = mountModal()
  const chat = w.find('[data-testid="wb-chat"]')
  expect(chat.exists()).toBe(true)
  expect(chatProps[0]).toMatchObject({ projectId: 'p1', projectName: '支付网关', conversationId: 'c1', activeConversationId: 'c1' })
})

test('标题 = 项目名 · 对话标题;无 title 时回落项目名', () => {
  expect(mountModal().text()).toContain('支付网关 · 排查重启')
  expect(mountModal({ ...CONV, title: null }).text()).toContain('支付网关')
})

test('切换 conversation → :key 重建 WorkbenchChat(新实例)', async () => {
  chatProps.length = 0
  const w = mountModal()
  await w.setProps({ conversation: { ...CONV, id: 'c2' } })
  expect(w.find('[data-testid="wb-chat"]').exists()).toBe(true)
  expect(chatProps.at(-1)).toMatchObject({ conversationId: 'c2' })
})

// 关闭通路:Modal 壳 emit update:modelValue=false → ChatModal 原样透传给父级
// (ChatPresence 靠它把 selected 置空;透传链断则 Modal 永远关不上)
test('Modal 桩 emit update:modelValue=false → 对外 emitted 收到 false', () => {
  const w = mountModal()
  w.findComponent({ name: 'Modal' }).vm.$emit('update:modelValue', false)
  expect(w.emitted('update:modelValue')).toEqual([[false]])
})
