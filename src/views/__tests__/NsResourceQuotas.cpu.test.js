import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

// 回归:创建表单 cpuHard 默认 8000(毫核),保存发 limits.cpu="8000m"。
const addSpy = vi.fn(async () => {})
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: ref([]) }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c', setNamespace: vi.fn(), fetchResourceQuotas: vi.fn(),
    addResourceQuota: addSpy,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'anydoor' } }), useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

import NsResourceQuotas from '../NsResourceQuotas.vue'

function mountView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } })
  return mount(NsResourceQuotas, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
      mocks: { $t: (k) => k },
      // Modal stub 内联渲染 → 创建表单始终可访问;其余组件 stub 掉聚焦被测逻辑
      stubs: {
        Breadcrumbs: true,
        Modal: { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' },
        Pagination: true, ProgressBar: true, DataTable: true,
      },
    },
  })
}
const flush = (ms = 80) => new Promise(r => setTimeout(r, ms))

describe('NsResourceQuotas CPU 毫核(创建)', () => {
  it('cpuHard 默认 8000、placeholder=8000;填 name+cpuHard → 保存 limits.cpu="8000m"', async () => {
    const w = mountView()
    await flush()
    const cpuInput = w.find('input[placeholder="8000"]')
    expect(cpuInput.exists()).toBe(true)
    expect(cpuInput.element.value).toBe('8000')          // 默认值已改毫核
    await w.find('input[placeholder="my-quota"]').setValue('my-rq')
    await cpuInput.setValue('8000')
    const createBtn = w.findAll('button').find(b => b.text().includes('common.create'))
    await createBtn.trigger('click')
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy.mock.calls.at(-1)[0].hard['limits.cpu']).toBe('8000m')
  })
})
