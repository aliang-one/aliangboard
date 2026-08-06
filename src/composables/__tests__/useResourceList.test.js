import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { useResourceList } from '../useK8sQuery.js'

// 集成测试：用真实 QueryClient + mock fetcher 挂载，验证 useResourceList（13 个迁移页共用的原语）端到端可用。
function mountWithQuery(setupFn) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } })
  const Test = defineComponent({ setup: setupFn, render() { return h('div') } })
  const wrapper = mount(Test, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } })
  return { wrapper, queryClient }
}
const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

describe('useResourceList integration', () => {
  it('calls fetcher and exposes resolved data', async () => {
    const fetcher = vi.fn(async () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    let q
    const { queryClient } = mountWithQuery(() => { q = useResourceList({ key: ['t', 'list'], fetcher }); return {} })
    expect(fetcher).toHaveBeenCalledTimes(1) // 挂载即触发 fetch
    await flush()
    expect(q.data.value).toHaveLength(3)
    expect(q.isLoading.value).toBe(false)
    queryClient.clear()
  })

  it('mockMode returns mock seed and does not call fetcher', async () => {
    const fetcher = vi.fn(async () => ['should-not-be-called'])
    const mock = [{ name: 'mock-a' }]
    let q
    const { queryClient } = mountWithQuery(() => { q = useResourceList({ key: ['t', 'mock'], fetcher, mock, mockMode: true }); return {} })
    await flush()
    expect(fetcher).not.toHaveBeenCalled()
    expect(q.data.value).toEqual([{ name: 'mock-a' }])
    queryClient.clear()
  })

  it('refetches after invalidateQueries', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => { calls++; return [{ n: calls }] })
    let q
    const { queryClient } = mountWithQuery(() => { q = useResourceList({ key: ['t', 'inv'], fetcher }); return {} })
    await flush()
    expect(calls).toBe(1)
    await queryClient.invalidateQueries({ queryKey: ['t', 'inv'] })
    await flush()
    expect(calls).toBe(2) // invalidate 触发重拉（CRUD 后即时刷新的机制）
    queryClient.clear()
  })
})
