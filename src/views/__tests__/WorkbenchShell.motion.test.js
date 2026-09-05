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

test('staggered 入场:头部 wb-rise 立即/tab 条 40ms 延迟;pane 挂 wb-rise 且随 tab 切换重播', async () => {
  const w = mountShell('admin')
  const sections = w.findAll('section .animate-wb-rise')
  expect(sections.length).toBeGreaterThanOrEqual(3)
  expect(sections[0].classes().join(' ')).not.toContain('animation-delay')
  expect(sections[1].classes().join(' ')).toContain('[animation-delay:40ms]')
  // 初始 pane(projects)在带 wb-rise 的包装层里
  expect(w.find('[data-test-stub="projects"]').element.closest('.animate-wb-rise')).toBeTruthy()
  // 切 tab:pane 重挂后仍带 wb-rise(class 在 :key 重播机制上)
  await w.findAll('button').find(b => b.text().includes('知识')).trigger('click')
  expect(w.find('[data-test-stub="ledger"]').element.closest('.animate-wb-rise')).toBeTruthy()
})

test('动效 token 在案:wb-pulse(舷板激活辉光脉冲)与 wb-rise(both fill 防延迟闪现)', () => {
  expect(tailwindConfig.theme.extend.animation['wb-pulse']).toBeTruthy()
  expect(tailwindConfig.theme.extend.animation['wb-rise']).toContain('both')
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
