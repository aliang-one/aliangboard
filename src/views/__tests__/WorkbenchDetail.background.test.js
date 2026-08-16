// 「挂到后台」按钮契约:agent 模式显示;点击不动对话,直接跳 当前 ns 的 NamespaceOverview,
// 无 ns 时跳 /cluster。edit 模式不显示。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const pushed = vi.hoisted(() => [])
const api = vi.hoisted(() => ({
  // 组件 load() 读 res.project/res.files/res.commits(非平铺 project),mock 须匹配真实契约
  getProject: vi.fn(async () => ({ project: { id: 'p1', name: 'P1', clusterName: 'c1' }, files: [], commits: [] })),
  getLedger: vi.fn(async () => ({})),
  readFile: vi.fn(async () => ({ content: '' })),
  conversations: { list: vi.fn(async () => []) },
  reconcile: vi.fn(async () => ({})),
}))
// getSavedClusters/activeApiServer:cluster store 实例化时(line 84-85)即调,须在 mock 里提供
vi.mock('@/api/client', () => ({ workbenchApi: api, getSavedClusters: () => [], activeApiServer: () => '' }))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: to => { pushed.push(to) } }),
  useRoute: () => ({ params: { id: 'p1' } }),
  // WorkbenchDetail setup 调用 onBeforeRouteLeave(SP4 dirty 守卫),mock 须提供
  onBeforeRouteLeave: () => {},
}))
vi.mock('@/components/workbench/WorkbenchChat.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/composables/useToast.js', () => ({ notify: vi.fn() }))

import WorkbenchDetail from '@/views/WorkbenchDetail.vue'
import { useClusterStore } from '@/stores/cluster'
import { createPinia } from 'pinia'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: {
  workbench: { detail: { backgroundChat: '挂到后台', backgroundChatTitle: '后台继续运行' } },
} } })

async function mountDetail(mode = 'agent') {
  localStorage.setItem('aliangboard.workbench.mode', mode)
  const w = mount(WorkbenchDetail, { global: { plugins: [createPinia(), i18n] } })
  await flushPromises()
  return w
}

beforeEach(() => { pushed.length = 0; localStorage.clear() })

test('agent 模式显示「挂到后台」;点击 → 跳当前 ns 的 NamespaceOverview', async () => {
  const w = await mountDetail('agent')
  const btn = w.find('[data-testid="background-chat-btn"]')
  expect(btn.exists()).toBe(true)
  useClusterStore().currentNamespace = 'prod' // store ref 直改
  await btn.trigger('click')
  expect(pushed[0]).toEqual({ name: 'NamespaceOverview', params: { namespace: 'prod' } })
})

test('无当前 ns → 跳 /cluster', async () => {
  const w = await mountDetail('agent')
  useClusterStore().currentNamespace = ''
  await w.find('[data-testid="background-chat-btn"]').trigger('click')
  expect(pushed[0]).toBe('/cluster')
})

test('edit 模式不显示按钮', async () => {
  const w = await mountDetail('edit')
  expect(w.find('[data-testid="background-chat-btn"]').exists()).toBe(false)
})
