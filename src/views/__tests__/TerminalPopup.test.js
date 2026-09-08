// 终端弹窗页(新浏览器标签页):URL 里的 sid 必须透传给 InteractiveTerminal 的 session-id,
// 网关才能按「稳定会话标识」attach 回同一 tmux 会话(浮动窗口同源行为)。漏传 → 网关降级
// 一次性 exec,角标「⚠ 刷新不保留」(镜像里明明有 tmux——提示语也跟着失真)。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { i18n } from '@/i18n'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getSessionToken: () => 'tok' }
})

import TerminalPopup from '@/views/TerminalPopup.vue'
import { POPUP_ALIVE_KEY } from '@/utils/popupSync'

// InteractiveTerminal 桩:捕获 props(真组件会开 WS,桩内不连)
const termProps = []
const TermStub = defineComponent({
  props: ['podName', 'namespace', 'container', 'sessionId', 'attach', 'autoConnect', 'chrome'],
  emits: ['win-close'],
  template: '<div data-testid="term-stub" :data-sid="sessionId" @click="$emit(\'win-close\')"></div>',
  mounted() { termProps.push({ sessionId: this.sessionId, podName: this.podName, namespace: this.namespace, container: this.container, chrome: this.chrome }) },
})

async function mountPopup(query) {
  termProps.length = 0
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/terminal-popup', name: 'TerminalPopup', component: TerminalPopup }] })
  router.push(`/terminal-popup?${query}`)
  await router.isReady()
  return mount(TerminalPopup, {
    global: { plugins: [createPinia(), i18n, router], stubs: { InteractiveTerminal: TermStub } },
  })
}

test('URL query.sid 透传为 InteractiveTerminal 的 session-id', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  const w = await mountPopup('ns=ns1&pod=pod-a&container=main&name=term1&sid=term-abc123')
  expect(w.find('[data-testid="term-stub"]').attributes('data-sid')).toBe('term-abc123')
  expect(termProps[0]).toMatchObject({ sessionId: 'term-abc123', podName: 'pod-a', namespace: 'ns1', container: 'main' })
})

// 2026-09-08 单行头部收编:外部 36px 顶条退役,终端 chrome='page'(头部仅红点=关窗,
// 仅 window.close() 不杀会话——会话由 tmux 承载,任务栏 chip 靠墓碑对账回收)。
test('单行头部:chrome=page 透传;红点(win-close)只关标签页不杀会话', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  const w = await mountPopup('ns=ns1&pod=pod-a&container=main&name=term1&sid=term-abc123')
  expect(termProps[0].chrome).toBe('page')
  const realClose = window.close
  window.close = vi.fn()
  try {
    await w.find('[data-testid="term-stub"]').trigger('click')
    expect(window.close).toHaveBeenCalled()
  } finally { window.close = realClose }
})

test('URL 无 sid(直接敲地址):session-id 退化为空串,由网关按一次性 exec 兜底,不炸', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  const w = await mountPopup('ns=ns1&pod=pod-a&container=main&name=term1')
  expect(termProps[0].sessionId).toBe('')
})

test('弹窗页 mount 即发存活信标(kind=pod);缺 sid 不发(2026-09-01 状态对账)', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  localStorage.removeItem(POPUP_ALIVE_KEY)
  const w = await mountPopup('ns=ns1&pod=pod-a&container=main&name=term1&sid=term-abc123')
  expect(JSON.parse(localStorage.getItem(POPUP_ALIVE_KEY))).toMatchObject({
    kind: 'pod', sid: 'term-abc123', meta: { namespace: 'ns1', podName: 'pod-a', container: 'main' },
  })
  w.unmount()
  localStorage.removeItem(POPUP_ALIVE_KEY)
  const w2 = await mountPopup('ns=ns1&pod=pod-a&container=main&name=term1')   // 无 sid:手输 URL
  expect(localStorage.getItem(POPUP_ALIVE_KEY)).toBeNull()
  w2.unmount()
})
