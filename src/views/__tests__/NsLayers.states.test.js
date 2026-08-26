import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@/i18n'

// 共享 dataRef（ref 化以便 data 变化触发重渲）：三条查询共用，验证三态切换
const dataRef = ref(null)
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: vi.fn(() => ({ data: dataRef, isPending: { value: dataRef.value === null }, refetch: vi.fn() })),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'default' } }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    setNamespace: vi.fn(),
    fetchWorkloads: vi.fn(async () => []),
    fetchServices: vi.fn(async () => []),
    fetchIngresses: vi.fn(async () => []),
    reassignLayer: vi.fn(),
    watchStateOf: () => 'off',
  }),
}))

import NsLayers from '../NsLayers.vue'

beforeEach(() => { dataRef.value = null })

describe('NsLayers 三态', () => {
  it('无数据且 pending → 显示加载态(非空状态文案);空数组 → 真空态', async () => {
    const w = mount(NsLayers, { global: { plugins: [i18n], stubs: ['Modal', 'Breadcrumbs', 'StatusChip'] } })
    expect(w.text()).not.toContain('emptyState')          // 加载中不误报空
    dataRef.value = []
    await flushPromises()
    // 空数组 → 空状态卡片(渲染 ns.layers.emptyState 文案)
    expect(w.find('[data-test="layers-empty"]').exists()).toBe(true)
  })
})
