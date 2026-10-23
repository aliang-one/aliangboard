// SSH 弹窗页居中会话名(2026-10-23):取名链 store 记录优先(URL query 兜底)——
// 显示名 = label || name(服务器名);serverName 仍传服务器行名(左段 ssh:// 不被会话名污染);
// 改名走 sshStore.renameWindow(localStorage + 网关 label 端点);document.title/心跳 meta 跟随。
// store mock 用真 ref + 真 renameWindow 语义(改名回写 label),让 computed 链真实流转。
const state = vi.hoisted(() => ({ query: {}, store: null }))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: state.query }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k, p) => `${k}:${p?.name ?? ''}` }) }))
vi.mock('@/api/client', () => ({
  sshApi: { killSession: vi.fn(() => Promise.resolve({ ok: true })), setSessionLabel: vi.fn(() => Promise.resolve({ ok: true })) },
}))
vi.mock('@/stores/sshTerminals', () => ({
  genSid: vi.fn(() => 'ssh-fixed-new'),
  useSshTerminalStore: vi.fn(() => state.store),
}))

// stub:透传 props 供断言;按钮 emit rename 固定载荷
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: {
    name: 'SshTerminal',
    props: { serverId: String, serverName: String, sid: String, autoConnect: Boolean, chrome: [Boolean, String], cwd: String, title: String },
    emits: ['win-close', 'new-terminal', 'rename'],
    template: `<div data-test="term-stub" :data-server-name="serverName" :data-title="title"><button data-test="stub-rename" @click="$emit('rename', '跳板机')"></button><button data-test="stub-new" @click="$emit('new-terminal')"></button></div>`,
  },
}))

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import SshTerminalPopup from '../SshTerminalPopup.vue'
import { POPUP_ALIVE_KEY } from '@/utils/popupSync'

const makeStore = rows => {
  const windows = ref(rows)
  return {
    // getter 转发 .value:Pinia 真 store 会解包 ref,mock 裸对象须等效(否则 .find 不存在)
    get windows() { return windows.value },
    renameWindow: vi.fn((id, label) => { const w = windows.value.find(x => x.id === id); if (w) w.label = String(label ?? '').trim() }),
    closeWindow: vi.fn(),
  }
}
const mountPopup = async () => { const w = mount(SshTerminalPopup); await flushPromises(); return w }

beforeEach(() => {
  state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' }
  state.store = makeStore([{ id: 'ssh-abc', serverId: 'sv1', name: 'gw-1', label: '' }])
})
afterEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.useRealTimers() })

describe('SshTerminalPopup 居中会话名+改名', () => {
  it('会话名 store 记录优先:显示 label||name 传 title;serverName 传服务器行名', async () => {
    state.store = makeStore([{ id: 'ssh-abc', serverId: 'sv1', name: 'gw-1', label: '生产机' }])
    const w = await mountPopup()
    const stub = w.find('[data-test="term-stub"]')
    expect(stub.attributes('data-title')).toBe('生产机')     // label 优先
    expect(stub.attributes('data-server-name')).toBe('gw-1') // 左段身份仍是服务器行名
    expect(document.title).toContain('生产机')               // 标题跟随
  })

  it('label 空 = 回退 name;无本地记录(换浏览器)= 回退 query 名', async () => {
    const w = await mountPopup()
    expect(w.find('[data-test="term-stub"]').attributes('data-title')).toBe('gw-1')
    w.unmount()
    state.store = makeStore([])
    const w2 = await mountPopup()
    expect(w2.find('[data-test="term-stub"]').attributes('data-title')).toBe('gw-1')
  })

  it('改名:emit rename → renameWindow(sid, v) 落 store;标题/心跳 meta 跟随', async () => {
    vi.useFakeTimers()
    const w = await mountPopup()
    await w.find('[data-test="stub-rename"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="term-stub"]').attributes('data-title')).toBe('跳板机')   // store 回写 label → 响应式回灌
    expect(document.title).toContain('跳板机')
    // 心跳 meta 为 getter:下一次心跳(20s)起带新名
    vi.advanceTimersByTime(20000)
    expect(JSON.parse(localStorage.getItem(POPUP_ALIVE_KEY)).meta.name).toBe('跳板机')
    w.unmount()
  })

  it('改名后点「+」新建终端:新标签页 name 取当前会话名(sessionName),不取旧 query 值', async () => {
    state.store = makeStore([{ id: 'ssh-abc', serverId: 'sv1', name: 'gw-1', label: '生产机' }])
    const realOpen = window.open
    window.open = vi.fn(() => ({}))
    try {
      const w = await mountPopup()
      await w.find('[data-test="stub-new"]').trigger('click')   // stub 按钮 emit new-terminal
      await flushPromises()
      const url = window.open.mock.calls[0][0]
      expect(url).toContain('sid=ssh-fixed-new')
      expect(url).toContain(encodeURIComponent('生产机'))       // 当前会话名(label)
      expect(url).not.toContain(`name=${encodeURIComponent('gw-1')}&`)
      w.unmount()
    } finally { window.open = realOpen; vi.restoreAllMocks() }
  })
})
