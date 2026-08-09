import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

// 复现 NsIngress 列表「明明有数据却空白」的白屏回归。
// 根因:filtered computed 在无搜索词时 `return nsIngress`(返回 computed ref 本身,而非数组),
// Vue 模板自动解包只解一层 → 模板里 v-if="filtered.length" 取到 ref 对象的 .length(undefined)→ falsy
// → 渲染 v-else 空状态。搜索框一旦有内容,filtered 走 .value.filter 返回真数组,又正常了,
// 故表现为「经常空白」。与 i18n 无关(d2571ee 修过同批另一类 t 遮蔽白屏;本次是 computed ref 解包)。

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    nsServices: [],
    setNamespace: () => {},
    fetchIngresses: vi.fn(async () => [
      { name: 'my-test-ingress', namespace: 'default', className: 'nginx', rules: [], hosts: '', age: '1d' },
    ]),
    getServiceByName: () => null,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'default' } }),
  useRouter: () => ({ push: () => {} }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k) => k }),
}))

import NsIngress from '../NsIngress.vue'

const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

function mountIngress() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } })
  const w = mount(NsIngress, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
      // stub 掉无关子组件,聚焦被测的 filtered / 表格 / 空状态逻辑
      stubs: { Modal: true, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true },
    },
  })
  return { w, queryClient }
}

describe('NsIngress 列表 ref 解包(白屏回归)', () => {
  it('无搜索词时仍渲染数据行,而非空状态', async () => {
    const { w, queryClient } = mountIngress()
    await flush()
    // bug 下 v-if="filtered.length" 为假 → 空状态 → 不含数据行名,断言失败
    expect(w.text()).toContain('my-test-ingress')
    queryClient.clear()
  })
})
