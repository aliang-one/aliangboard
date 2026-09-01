// 手机适配 Wave 3 Task 3:NsWorkloadDetail 手机动作区 + 底部止血条。
// 红线:止血条(伸缩/重启)必须复用 openScale/handleRestart——确认流/权限 canMutate 零改动;
// 桌面/iPad 零回归:无止血条、既有用例断言零改动。
// mock 策略照 NsWorkloadDetail.edit-shell.test.js(cluster store 回真实 Deployment,
// canMutate 默认 true 不锁死;真实 i18n + Vue Query,不 stub Modal 以便断言弹窗打开)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
  raw: {
    metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
    spec: {
      replicas: 1, selector: { matchLabels: { app: 'demo' } },
      template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } },
    },
  },
}
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [demoWorkload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  restartWorkload: vi.fn(), scaleWorkload: vi.fn(),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' }, query: {} }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

async function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
  await flushPromises()
  return w
}

test('手机档:头部动作钮 40px 触控目标+容器换行;底部止血条(伸缩/重启)在场且走既有确认弹窗', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    // 头部动作钮容器换行
    const wrap = w.findAll('div').find(d => d.classes().join(' ').includes('max-sm:flex-wrap'))
    expect(wrap).toBeTruthy()
    // 头部动作钮(伸缩/重启所在容器)在手机档获得 min-h-40px 触控目标
    const scaleBtn = w.findAll('button').find(b => b.text() === i18n.global.t('workload.scale'))
    expect(scaleBtn).toBeTruthy()
    expect(scaleBtn.classes().join(' ')).toContain('max-sm:min-h-[40px]')
    // 止血条在场:伸缩/重启两钮(Deployment 可伸缩);sticky 非 fixed(挂 main 滚动流内,同 PodDetail 先例)
    const bar = w.find('[data-testid="workload-action-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.classes()).toContain('sticky')
    expect(bar.classes()).not.toContain('fixed')
    const barBtns = bar.findAll('button')
    expect(barBtns.length).toBe(2)
    expect(barBtns[0].text()).toContain(i18n.global.t('workload.scale'))
    expect(barBtns[1].text()).toContain(i18n.global.t('workload.restart'))
    // 点击伸缩 → 走既有 openScale(showScaleModal=true),标题= workload.modals.scaleTitle
    await barBtns[0].trigger('click')
    const modals = w.findAllComponents({ name: 'Modal' })
    expect(modals.length).toBeGreaterThan(0)
    const open = modals.filter(m => m.attributes('modelvalue') === 'true' || m.props('modelValue') === true)
    expect(open.length).toBe(1)
    expect(open[0].props('title')).toBe(i18n.global.t('workload.modals.scaleTitle'))
    w.unmount()
    document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('桌面档:无底部止血条(零回归)', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountDetail()
    expect(w.find('[data-testid="workload-action-bar"]').exists()).toBe(false)
    w.unmount()
    document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('手机档:止血条重启经确认弹窗(终审 B)——点开弹窗→确认才执行', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const bar = w.find('[data-testid="workload-action-bar"]')
    const restartBtn = bar.findAll('button').find(b => b.text().includes(i18n.global.t('workload.restart')))
    await restartBtn.trigger('click')
    const modals = w.findAllComponents({ name: 'Modal' })
    const open = modals.filter(m => m.props('modelValue') === true)
    expect(open.length).toBe(1)
    expect(open[0].props('title')).toBe(i18n.global.t('workload.modals.restartTitle'))
    expect(document.body.textContent).toContain(i18n.global.t('workload.modals.restartConfirm', { name: 'demo-deploy' }))
    // 确认钮在 Teleport body 内:点击后弹窗关闭
    const confirmBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.restart'))
    await confirmBtn.click()
    await flushPromises()
    expect(document.body.textContent).not.toContain(i18n.global.t('workload.modals.restartConfirm', { name: 'demo-deploy' }))
    w.unmount()
    document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
