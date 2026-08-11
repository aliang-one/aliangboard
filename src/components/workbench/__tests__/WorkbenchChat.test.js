import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

// vi.mock factories are hoisted to the top of the file — they can't reference
// ordinary top-level vars. vi.hoisted runs alongside the mock so both exist at
// the same hoisted moment. Tests reset the spy impls before each case.
const api = vi.hoisted(() => ({
  conversations: {
    create: vi.fn(),
    append: vi.fn(),
    get: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
  },
  search: vi.fn(),
}))

vi.mock('@/api/client', () => ({ workbenchApi: api }))

// Mock Modal (teleport / nested component not relevant to send() branching)
vi.mock('@/components/common/Modal.vue', () => ({
  default: {
    name: 'Modal',
    template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
    props: ['modelValue', 'title', 'width'],
  },
}))

import WorkbenchChat from '../WorkbenchChat.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: { zh: { workbench: { chat: { userMessage: 'Type...', title: 'AI', hint: 'hint', recapSummary: '之前的对话摘要', noAnswer: '(无回答)' } } } },
})

async function mountChat(props = {}) {
  return mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo', ...props },
    global: { plugins: [i18n] },
  })
}

// Reset call history between tests so create/append assertions are scoped to one test.
beforeEach(() => {
  api.conversations.create.mockClear()
  api.conversations.append.mockClear()
  api.conversations.get.mockClear()
})

test('send() calls conversations.create when no activeConversationId', async () => {
  const w = await mountChat()
  await w.find('textarea').setValue('hello world')
  api.conversations.create.mockResolvedValue({ id: 'conv-new', status: 'running' })
  api.conversations.get.mockResolvedValue({ id: 'conv-new', status: 'done', content: 'ok', trace: '[]', steps: 0 })
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  await flushPromises()

  expect(api.conversations.create).toHaveBeenCalledTimes(1)
  expect(api.conversations.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', message: 'hello world' }))
  expect(api.conversations.append).not.toHaveBeenCalled()
})

test('send() calls conversations.append when activeConversationId is set', async () => {
  const w = await mountChat({ activeConversationId: 'conv-active' })
  await w.find('textarea').setValue('follow up')
  api.conversations.append.mockResolvedValue({ id: 'conv-active', status: 'running' })
  api.conversations.get.mockResolvedValue({ id: 'conv-active', status: 'done', content: 'ok2', trace: '[]', steps: 0 })
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  await flushPromises()

  expect(api.conversations.append).toHaveBeenCalledTimes(1)
  expect(api.conversations.append).toHaveBeenCalledWith('conv-active', expect.objectContaining({ message: 'follow up' }))
  expect(api.conversations.create).not.toHaveBeenCalled()
})

test('recap card renders when conv.recap is truthy', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-recap',
    status: 'done',
    content: 'answer',
    trace: '[]',
    steps: 1,
    recap: 'Earlier we discussed nginx config.',
    messages: [],
  })
  const w = await mountChat({ conversationId: 'conv-recap' })
  await flushPromises()
  await flushPromises()
  expect(w.html()).toContain('Earlier we discussed nginx config.')
})

test('multi-turn: conv.messages renders multiple ChatTurns', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-multi',
    status: 'done',
    trace: '[]',
    steps: 2,
    recap: '',
    messages: [
      { role: 'user', content: 'what is nginx?', refs: null, trace: null },
      { role: 'assistant', content: 'nginx is a web server', refs: null, trace: '[{"tool":"search","args":{}}]' },
      { role: 'user', content: 'how to install?', refs: null, trace: null },
      { role: 'assistant', content: 'apt-get install nginx', refs: null, trace: null },
    ],
  })
  const w = await mountChat({ conversationId: 'conv-multi' })
  await flushPromises()
  await flushPromises()
  const html = w.html()
  // Each message renders its content somewhere in the turns
  expect(html).toContain('what is nginx?')
  expect(html).toContain('nginx is a web server')
  expect(html).toContain('how to install?')
  expect(html).toContain('apt-get install nginx')
})

test('multi-turn: empty messages falls back to single-turn from userMessage', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-old',
    status: 'done',
    content: 'legacy answer',
    trace: '[]',
    steps: 0,
    userMessage: 'legacy question',
    messages: [],
  })
  const w = await mountChat({ conversationId: 'conv-old' })
  await flushPromises()
  await flushPromises()
  const html = w.html()
  expect(html).toContain('legacy question')
  expect(html).toContain('legacy answer')
})
