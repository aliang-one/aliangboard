// ChatPresence 契约:轮询 → 显隐/徽标;单个活跃直开 Modal;≥2 个先微型列表;
// 空列表不渲染;连续 3 失败隐藏(成功自愈恢复);打开 Modal 即写 readAt;
// Modal 关闭(update:modelValue=false)清空 selected。
// 近期动态模型(2026-08-17):点击/读过只清「新动态」小点,条目与 FAB 常驻不消失。
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

test('1 个未读终态:点击直开 Modal 并写 readAt;FAB 与条目保留(近期动态模型)', async () => {
  const w = await mountPresence({ conversations: [conv({ status: 'done' })] })
  const fab = w.find('[data-testid="chat-presence-fab"]')
  expect(fab.exists()).toBe(true)
  expect(fab.text()).toContain('smart_toy') // update 档
  await fab.trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="chat-modal"]').text()).toBe('c1')
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true, '读过不清条目——FAB 保留')
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

test('微型列表:有新动态的行亮点,无动态的行不亮', async () => {
  localStorage.setItem('aliangboard.chat.readAt', JSON.stringify({ b: 1_700_000_100_000 })) // b 已看过最新
  const w = await mountPresence({ conversations: [
    conv({ id: 'a', updatedAt: T0 }),                                       // 无记录 → 亮
    conv({ id: 'b', projectId: 'p2', projectName: 'P2', status: 'done', updatedAt: T0 - 1000 }), // readAt 晚于 updatedAt → 不亮
  ] })
  await w.find('[data-testid="chat-presence-fab"]').trigger('click')
  const dots = w.findAll('[data-testid="update-dot"]')
  expect(dots.length).toBe(1)
})

// 评审 Critical-1 回归:Modal 移出显隐容器。单个未读终态点击 FAB → openConv 同步 markRead,
// 近期动态模型下读过不清条目(FAB 常驻),打开中的 Modal 只许由 selected 控制挂载/卸载
// (旧代码 Modal 住在 v-if 容器里,会连同尚未挂载完的 Modal 一起消失,用户一点全没了)
test('单个未读终态:点击 FAB 后 FAB 保留,Modal 挂载且持续存在', async () => {
  const w = await mountPresence({ conversations: [conv({ status: 'done' })] })
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true)
  await w.find('[data-testid="chat-presence-fab"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true, '读过不清条目——FAB 保留')
  expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
  expect(w.find('[data-testid="chat-modal"]').text()).toBe('c1')
})

// 评审 Critical-1 回归:Modal 开着唯一 running 对话跑完,下一轮 poll 对 selected 刷 readAt →
// 近期动态模型下条目常驻(idle 档安静常驻),但打开中的 Modal 不得被强卸载
// (spec:Modal 开着对话终态应正常收尾)。
// fake timers 推进一个轮询周期(10s);advanceTimersByTimeAsync 每轮走真实 macrotask,
// 兼作微任务冲刷(fake timers 下 flushPromises 的 setImmediate 可能被 faked,不依赖它)
test('Modal 开着唯一 running 对话跑完:下一轮 poll 后 idle 档 FAB 常驻,Modal 不被卸载', async () => {
  vi.useFakeTimers() // 假时钟从 beforeEach setSystemTime 的 T0+30s 起跳,Date 一并接管
  try {
    api.active.mockImplementation(async () => ({ conversations: [conv()] }))
    const w = mount(ChatPresence, { global: { plugins: [i18n] } })
    await vi.advanceTimersByTimeAsync(0) // 冲刷首轮 poll(onMounted)+渲染
    await w.find('[data-testid="chat-presence-fab"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0) // 解析 defineAsyncComponent
    expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
    // 第二次轮询:跑完(done)且 updatedAt 更新;poll 对 selected 刷 readAt(poll 时钟 T0+40s)
    // → 新动态清空、落 idle 档,FAB 常驻——Modal 只许由 selected 卸载,不许被按钮壳带走
    api.active.mockImplementation(async () => ({ conversations: [conv({ status: 'done', updatedAt: T0 + 35_000 })] }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true)
    expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="chat-modal"]').text()).toBe('c1')
  } finally { vi.useRealTimers() }
})

// 关闭通路:Modal 开着时 ChatModal emit update:modelValue=false → selected 置空、Modal 卸载。
// FAB 在场与否取决于对话是否仍活跃 running,此处不断言 FAB(不误伤)
test('Modal 关闭:emit update:modelValue=false → chat-modal 卸载', async () => {
  const w = await mountPresence({ conversations: [conv()] })
  await w.find('[data-testid="chat-presence-fab"]').trigger('click')
  await flushPromises() // ChatModal 为 defineAsyncComponent,动态 import 解析需冲刷(同上)
  expect(w.find('[data-testid="chat-modal"]').exists()).toBe(true)
  w.findComponent({ name: 'ChatModal' }).vm.$emit('update:modelValue', false)
  await flushPromises()
  expect(w.find('[data-testid="chat-modal"]').exists()).toBe(false)
})

test('无活跃对话 → 整个组件不渲染按钮', async () => {
  const w = await mountPresence({ conversations: [] })
  expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(false)
})

// 组件头注释契约「连续 3 次轮询失败(含 401)→ 隐藏按钮但继续轮询,成功自愈恢复」。
// fake timers 同「Modal 开着跑完」测试:advanceTimersByTimeAsync 兼作冲刷(不依赖 flushPromises)
test('连续 3 失败隐藏 FAB;成功自愈复活;非空列表 3 失败同样隐藏(1~2 次不隐藏)', async () => {
  vi.useFakeTimers()
  try {
    const fail = async () => { throw new Error('network down') }
    api.active.mockImplementation(fail)
    const w = mount(ChatPresence, { global: { plugins: [i18n] } })
    await vi.advanceTimersByTimeAsync(0) // 首拉失败(failCount=1)
    await vi.advanceTimersByTimeAsync(10_000) // 失败 2
    await vi.advanceTimersByTimeAsync(10_000) // 失败 3 → failCount=MAX_FAILS
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(false) // 隐藏/不渲染
    // 成功自愈:继续轮询未停 → failCount 归零 + running 回填 → FAB 复活
    api.active.mockImplementation(async () => ({ conversations: [conv()] }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true)
    // 反向钉死 MAX_FAILS 门:conversations 非空时 1~2 次失败不隐藏,第 3 次才隐藏
    api.active.mockImplementation(fail)
    await vi.advanceTimersByTimeAsync(10_000) // 失败 1
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000) // 失败 2
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000) // 失败 3 → 隐藏
    expect(w.find('[data-testid="chat-presence-fab"]').exists()).toBe(false)
  } finally { vi.useRealTimers() }
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
