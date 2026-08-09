import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

// 回归:filteredPolicies 曾 `const all = nsNetworkPolicies`(computed ref,漏 .value)。
// 默认 'all' → 返回 ref → 模板 filteredPolicies.length 取 ref.length(undefined)→ 空状态;
// 非 all 过滤 → all.filter 抛 "not a function"。与 NsIngress 同类 computed-ref 解包白屏。
// 此测试注入数据、深挂载并 flush,迫使 filteredPolicies 求值,断言数据行渲染。

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    remoteMode: false, // demo → useResourceList 用 mock 种子,不发请求
    currentCluster: 'demo',
    networkPolicyList: [
      { name: 'my-pol', namespace: 'default', policyTypes: ['Ingress', 'Egress'], ingressRules: [], egressRules: [], podSelector: {}, age: '1d' },
    ],
    setNamespace: () => {},
    fetchNetworkPolicies: vi.fn(async () => []),
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'default' } }),
  useRouter: () => ({ push: () => {} }),
}))

import NsNetworkPolicies from '../NsNetworkPolicies.vue'

const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

test('NsNetworkPolicies 有数据时渲染行(computed ref 解包回归)', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } })
  const w = mount(NsNetworkPolicies, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient }]],
      stubs: { NetworkPolicyEditor: true, Modal: true, Pagination: true, Breadcrumbs: true },
    },
  })
  await flush()
  expect(w.text()).toContain('my-pol')
  queryClient.clear()
})
