import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

// 回归:filtered 曾 `const list = nsEndpoints`(computed ref,漏 .value)。
// 无搜索词 → return list(返回 ref 本身)→ 模板 filtered.length 取 ref.length(undefined)→ 空状态;
// 有搜索词 → list.filter 抛 "not a function"。与 NsIngress 同类 computed-ref 解包白屏。

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    watchStateOf: () => 'off',
    currentCluster: 'demo',
    serviceList: [],
    setNamespace: () => {},
    fetchEndpoints: vi.fn(async () => [
      { name: 'my-ep', namespace: 'default', addresses: ['10.0.0.1'], notReadyAddresses: [], ports: [{ port: 80, protocol: 'TCP' }], age: '1d' },
    ]),
    fetchServices: vi.fn(async () => []),
    generateYAML: () => '',
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'default' } }),
  useRouter: () => ({ push: () => {} }),
}))

import NsEndpoints from '../NsEndpoints.vue'

const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

test('NsEndpoints 有数据时渲染行(computed ref 解包回归)', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } })
  const w = mount(NsEndpoints, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient }]],
      stubs: { YamlEditor: true, Pagination: true, Breadcrumbs: true },
    },
  })
  await flush()
  expect(w.text()).toContain('my-ep')
  queryClient.clear()
})
