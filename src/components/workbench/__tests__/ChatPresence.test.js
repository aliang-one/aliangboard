// ChatPresence 契约:轮询 → 显隐/徽标;单个活跃直开 Modal;≥2 个先微型列表;
// 空列表不渲染;连续 3 失败隐藏;打开 Modal 即写 readAt。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import { readFileSync } from 'node:fs'

const api = vi.hoisted(() => ({ active: vi.fn() }))
vi.mock('@/api/client', () => ({ workbenchApi: { conversations: api } }))
// __esModule: vitest 4 mock 命名空间缺它时 defineAsyncComponent 不解包 .default,
// VTU 对命名空间代理探 __isTeleport 即抛 "[vitest] No __isTeleport export"
vi.mock('../ChatModal.vue', () => ({
  __esModule: true,
  default: {
    name: 'ChatModal',
    props: ['modelValue', 'conversation'],
    emits: ['update:modelValue'],
    template: `<div v-if="modelValue" data-testid="chat-modal">{{ conversation?.id }}</div>`,
  },
}))

import ChatPresence from '../ChatPresence.vue'

// happy-dom 下 import.meta.url 被改写为非 file:// URL,readFileSync(URL) 会抛
// "must be of scheme file";vitest 恒以配置根为 cwd,用 cwd 相对路径读同一文件。
// zh.json 顶层无 "zh" 键(根即分区,app 的 src/i18n.js 同样直接用根对象)
const messages = { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) }
const i18n = createI18n({ legacy: false, locale: 'zh', messages })
const T0 = 1_700_000_000_000
const conv = (over = {}) => ({ id: 'c1', projectId: 'p1', projectName: 'P1', title: null, status: 'running', updatedAt: T0, ...over })

// relTime 依赖 Date.now;固定在 T0 之后 1 分钟内,显示「刚刚」无需断言文案
beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  vi.setSystemTime(T0 + 30_000)
})

async function mountPresence(activeResult) {
  api.active.mockImplementation(async () => activeResult)
  const w = mount(ChatPresence, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('1 个 running → 按钮显示转圈图标,点击直开 Modal 并写 readAt', async () => {
  const w = await mountPresence({ conversations: [conv()] })
  const fab = w.find('[data-testid="chat-presence-fab"]')
  expect(fab.exists()).toBe(true)
  expect(fab.text()).toContain('progress_activity')
  await fab.trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="chat-modal"]').text()).toBe('c1')
  expect(JSON.parse(localStorage.getItem('aliangboard.chat.readAt'))).toHaveProperty('c1')
})

test('paused → pending_actions 图标(优先级最高)', async () => {
  const w = await mountPresence({ conversations: [conv({ status: 'paused' })] })
  expect(w.find('[data-testid="chat-presence-fab"]').text()).toContain('pending_actions')
})

test('2 个活跃 → 数字角标;点击先出微型列表,选行再开 Modal', async () => {
  const w = await mountPresence({ conversations: [conv({ id: 'a' }), conv({ id: 'b', projectId: 'p2', projectName: 'P2' })] })
  const fab = w.find('[data-testid="chat-presence-fab"]')
  expect(fab.text()).toContain('2')
  expect(w.find('[data-testid="presence-list"]').exists()).toBe(false)
  await fab.trigger('click')
  expect(w.find('[data-testid="presence-list"]').exists()).toBe(true)
  await w.findAll('[data-testid="presence-row"]')[1].trigger('click')
  await flushPromises() // ChatModal 为 defineAsyncComponent,动态 import 解析需冲刷(同测试 1)
  expect(w.find('[data-testid="chat-modal"]').text()).toBe('b')
})

// 评审 Critical-1 回归:Modal 移出显隐容器。单个未读终态点击 FAB → openConv 同步 markRead →
// visible 归零 → presence.show=false 收掉按钮壳,但打开中的 Modal 必须持续存在
// (旧代码 Modal 住在 v-if 容器里,会连同尚未挂载完的 Modal 一起消失,用户一点全没了)
test('单个未读终态:点击 FAB 后 FAB 消失,Modal 挂载且持续存在', async () => {
  const w = await mountPresence({ conversations: [conv({ status: 'done' })] })
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true)
  await w.find('[data-testid="chat-presence-fab"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(false)
  expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
  expect(w.find('[data-testid="chat-modal"]').text()).toBe('c1')
})

// 评审 Critical-1 回归:Modal 开着唯一 running 对话跑完,下一轮 poll 对 selected 刷 readAt →
// 读终态收掉按钮壳,但打开中的 Modal 不得被强卸载(spec:Modal 开着对话终态应正常收尾)。
// fake timers 推进一个轮询周期(10s);advanceTimersByTimeAsync 每轮走真实 macrotask,
// 兼作微任务冲刷(fake timers 下 flushPromises 的 setImmediate 可能被 faked,不依赖它)
test('Modal 开着唯一 running 对话跑完:下一轮 poll 后 FAB 消失但 Modal 不被卸载', async () => {
  vi.useFakeTimers() // 假时钟从 beforeEach setSystemTime 的 T0+30s 起跳,Date 一并接管
  try {
    api.active.mockImplementation(async () => ({ conversations: [conv()] }))
    const w = mount(ChatPresence, { global: { plugins: [i18n] } })
    await vi.advanceTimersByTimeAsync(0) // 冲刷首轮 poll(onMounted)+渲染
    await w.find('[data-testid="chat-presence-fab"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0) // 解析 defineAsyncComponent
    expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
    // 第二次轮询:跑完(done)且 updatedAt 更新;poll 对 selected 刷 readAt(poll 时钟 T0+40s)
    // → 读终态、按钮壳消失——Modal 只许由 selected 卸载,不许被按钮壳带走
    api.active.mockImplementation(async () => ({ conversations: [conv({ status: 'done', updatedAt: T0 + 35_000 })] }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(false)
    expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="chat-modal"]').text()).toBe('c1')
  } finally { vi.useRealTimers() }
})

test('无活跃对话 → 整个组件不渲染按钮', async () => {
  const w = await mountPresence({ conversations: [] })
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(false)
})

// 需求书注:$route 全局属性注入与 useRoute()(走 inject)不兼容,改挂最小真路由,
// 让 useRoute().name === 'WorkbenchProject' 成立;断言不变
test('正在看的项目被排除(路由 WorkbenchProject)', async () => {
  api.active.mockImplementation(async () => ({ conversations: [conv({ projectId: 'p1' }), conv({ id: 'b', projectId: 'p2', projectName: 'P2', status: 'paused' })] }))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/workbench/:id', name: 'WorkbenchProject', component: { render: () => null } }],
  })
  router.push('/workbench/p1')
  await router.isReady()
  const w = mount(ChatPresence, { global: { plugins: [i18n, router] } })
  await flushPromises()
  // p2 的 paused 仍在;p1 的 running 被排除
  expect(w.find('[data-testid="chat-presence-fab"]').text()).toContain('pending_actions')
  // 钉死排除生效:若 p1 未被排除,badgeCount=2 会显示数字角标
  // (上面 paused 图标断言在排除失效时照样绿,挡不住回归)
  expect(w.find('[data-testid="chat-presence-fab"]').text()).not.toContain('2')
})
