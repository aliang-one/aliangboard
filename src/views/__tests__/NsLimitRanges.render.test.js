import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

// 回归:usePagination 必须直传 computed,不能 computed(() => nsXxx) 二次包裹。
// 二次包裹 → 分页器 source.value 是 ComputedRef(.length undefined)→ paginated 恒 [] →
// 表头渲染但无数据行 → 「策略组列表一个都不展示」。

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    setNamespace: vi.fn(),
    fetchLimitRanges: vi.fn(async () => ([
      { name: 'lr1', namespace: 'anydoor', defaultCPU: '500m', defaultMemory: '512Mi', maxCPU: '2', maxMemory: '4Gi', age: '1d' },
      { name: 'lr-other-ns', namespace: 'kube-system', defaultCPU: '100m', defaultMemory: '128Mi', maxCPU: '1', maxMemory: '1Gi', age: '2d' },
    ])),
    addLimitRange: vi.fn(async () => {}), deleteLimitRange: vi.fn(async () => {}),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'anydoor' } }), useRouter: () => ({ push: vi.fn() }) }))
// 保留 vue-i18n 真实导出(createI18n 等):视图经 CreateWithYamlButton→CreateFromYamlDialog→useResourceApply
// 拉入真实 '@/i18n',其顶层调 createI18n——mock 若只给 useI18n 会在 import 期炸整个测试文件。
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useI18n: () => ({ t: (k) => k }) }
})

import NsLimitRanges from '../NsLimitRanges.vue'

const mountView = () => mount(NsLimitRanges, {
  global: {
    plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } }) }]],
    mocks: { $t: (k) => k },
    stubs: { Breadcrumbs: true, Modal: true, Pagination: true },
  },
})
const flush = (ms = 120) => new Promise(r => setTimeout(r, ms))

describe('NsLimitRanges 渲染(分页不二次包裹)', () => {
  it('fetcher 返回本 ns 数据 → 渲染 lr1,过滤掉其它 ns', async () => {
    const w = mountView()
    await flush()
    const rows = w.findAll('tbody tr').map(tr => tr.text())
    expect(rows.some(t => t.includes('lr1'))).toBe(true)
    expect(rows.some(t => t.includes('lr-other-ns'))).toBe(false)
  })
})
