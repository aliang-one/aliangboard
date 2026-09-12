// WorkbenchShell 入场动效(2026-09-05 转场批次,A 方案):
// ① 消双重淡入——根节点 animate-fade-in 摘除(AppLayout 的 wb-enter 转场接管入场);
// ② 头部/ tab 条 staggered 上浮(0/40ms,wb-rise both fill 防延迟期闪现);
// ③ 内容 pane 以 :key=activeTab 挂 wb-rise——tab 切换即重挂重播(不用 Vue Transition:
//    happy-dom 测不了 transitionend 时序,纯 class 动画零测试竞态);
// ④ 转场语言静态面:tailwind wb-pulse/wb-rise token 在案,main.css 定义 wb-enter 方向性入场。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'
import tailwindConfig from '../../../tailwind.config.js'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/views/WorkbenchProjects.vue', () => ({ default: { template: '<div data-test-stub="projects" />' } }))
vi.mock('@/views/WorkbenchLedger.vue', () => ({ default: { template: '<div data-test-stub="ledger" />' } }))
vi.mock('@/views/WorkbenchRecords.vue', () => ({ default: { template: '<div data-test-stub="records" />' } }))
vi.mock('@/views/WorkbenchServers.vue', () => ({ default: { template: '<div data-test-stub="servers" />' } }))
vi.mock('@/views/WorkbenchCredentials.vue', () => ({ default: { template: '<div data-test-stub="credentials" />' } }))
// 2026-09-12 导航重排:知识不再是平铺 button 而收进「更多」▾——切 pane 经 stub 的 more-item 触发
vi.mock('@/components/common/DropdownMenu.vue', () => ({ default: {
  props: ['triggerIcon', 'triggerLabel', 'items'],
  template: '<div data-test-stub="more"><button v-for="(it,i) in items" :key="i" data-test="more-item" @click="it.action">{{ it.label }}</button></div>',
} }))
import WorkbenchShell from '@/views/WorkbenchShell.vue'

function mountShell(role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchShell, { global: { plugins: [pinia, i18n] } })
}

test('消双重淡入:根节点不再带 animate-fade-in(AppLayout 转场接管)', () => {
  const w = mountShell('admin')
  expect(w.find('section').classes()).not.toContain('animate-fade-in')
})

test('staggered 入场:门面标题栏立即/tabs 40ms;pane 挂 wb-rise 且随 tab 切换重播;门面瓷砖+一次性 sheen 在案', async () => {
  const w = mountShell('admin')
  const rises = w.findAll('section .animate-wb-rise')
  expect(rises.length).toBeGreaterThanOrEqual(3)
  expect(rises[0].classes().join(' ')).not.toContain('animation-delay')
  expect(rises[1].classes().join(' ')).toContain('[animation-delay:40ms]')
  expect(w.find('[data-test-stub="projects"]').element.closest('.animate-wb-rise')).toBeTruthy()
  await w.findAll('[data-test="more-item"]').find(b => b.text().includes('知识')).trigger('click')
  expect(w.find('[data-test-stub="ledger"]').element.closest('.animate-wb-rise')).toBeTruthy()
  // 门面:32px 品牌瓷砖(与顶栏 pill 瓷砖同配方)+ 挂载即播的一次性 sheen(入口→模块 logo 握手)
  const tile = w.find('[data-test="wb-facade-tile"]')
  expect(tile.exists()).toBe(true)
  expect(tile.classes()).toContain('bg-gradient-to-br')
  expect(tile.classes()).toContain('from-primary')
  expect(tile.classes()).toContain('to-primary-container')
  expect(tile.find('.material-symbols-outlined').text()).toBe('workspaces')
  expect(w.find('[data-test="wb-facade-sheen"]').classes()).toContain('animate-sheen')
  expect(w.find('[data-test="wb-facade-sheen"]').classes()).toContain('bg-no-repeat')
})

test('动效 token 在案:wb-pulse(舷板激活辉光脉冲)与 wb-rise(backwards fill:延迟期防闪现)', () => {
  // 2026-09-05 浮层受困事故:wb-rise 原用 both fill——动画结束后永久保留末帧 transform,
  // pane 成为 fixed 后代的包含块,弹窗/浮窗被困进 stage 裁切。backwards 同样在延迟期保持
  // 0% 帧(防闪现不变),但结束后释放 transform。禁回 both:scripts/ui-language-guard V3。
  expect(tailwindConfig.theme.extend.animation['wb-pulse']).toBeTruthy()
  expect(tailwindConfig.theme.extend.animation['wb-rise']).toContain('backwards')
  expect(tailwindConfig.theme.extend.animation['wb-rise']).not.toContain('both')
  expect(tailwindConfig.theme.extend.keyframes['wb-rise']).toBeTruthy()
  expect(tailwindConfig.theme.extend.keyframes['wb-pulse']).toBeTruthy()
})

test('方向性入场语言:main.css 定义 wb-enter(右→左滑入)且带 reduced-motion 兜底', () => {
  const css = readFileSync('./src/styles/main.css', 'utf8')
  expect(css).toContain('.wb-enter-enter-from')
  expect(css).toContain('translateX')
  const reduce = css.slice(css.indexOf('prefers-reduced-motion'))
  expect(reduce).toContain('wb-enter')
})
