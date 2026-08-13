import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// 回归:创建 HPA 必须在 invalidateQueries 之前 await store.addHPA。
// 根因:store.addHPA 远端走 remoteCreate(await api.applyYaml),HPA 落库要等 HTTP 完成;
// 若 handleCreate 不 await,则 invalidate 在 apply 完成前就触发 → Vue Query 重拉到旧(空)列表并缓存,
// 新建 HPA 不显示(addHPA 内的 refetch 只回填已孤立的 hpaList,视图读的是 Vue Query)。
// 对照:NsConfigMaps/NsServices/NsIngress/NsSecrets 均 `await store.addX` 后再 invalidate。

let resolveAdd
const addHPASpy = vi.fn(() => new Promise(r => { resolveAdd = r }))
const invalidateSpy = vi.fn()

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    setNamespace: vi.fn(),
    fetchHPAs: vi.fn(),
    fetchWorkloads: vi.fn(),
    addHPA: addHPASpy,
    deleteHPA: vi.fn(() => Promise.resolve()),
  }),
}))
vi.mock('@tanstack/vue-query', () => ({ useQueryClient: () => ({ invalidateQueries: invalidateSpy }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  // hpas + workloads 共用 stub;workloads 给 1 个 Deployment 供 targetName 下拉
  useResourceList: () => ({ data: { value: [{ name: 'app', type: 'Deployment', namespace: 'anydoor' }] } }),
}))
vi.mock('@/composables/usePagination', () => ({
  usePagination: () => ({ currentPage: { value: 1 }, pageSize: { value: 10 }, paginated: { value: [] }, total: { value: 0 } }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'anydoor' }, name: 'NsHPA', path: '/ns/anydoor/hpa' }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

import NsHPA from '../NsHPA.vue'

// Modal 用 Teleport to body,stub 成内联渲染 default+actions 槽,便于在 wrapper 内驱动表单。
const ModalStub = { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }

function mountHpa() {
  return mount(NsHPA, {
    global: {
      mocks: { $t: (k) => k },
      stubs: { Modal: ModalStub, Breadcrumbs: true, StatusChip: true, Pagination: true },
    },
  })
}

describe('NsHPA 创建须 await addHPA 后再 invalidate', () => {
  it('addHPA 未 resolve 前,不触发 invalidateQueries', async () => {
    const w = mountHpa()
    // 填创建表单(name + targetName)
    await w.find('input[placeholder="my-app-hpa"]').setValue('test-hpa')
    await w.findAll('select')[1].setValue('app') // 第二个 select = targetName
    // 点模态框「创建」
    const createBtn = w.findAll('button').find(b => b.text().includes('common.create'))
    await createBtn.trigger('click')

    expect(addHPASpy).toHaveBeenCalledTimes(1)
    // 关键:远端 apply 尚未完成(addHPA 未 resolve)→ 不得 invalidate
    expect(invalidateSpy).not.toHaveBeenCalled()

    // 创建落库后才 invalidate(拉到含新 HPA 的列表)
    resolveAdd()
    await flushPromises()
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['cluster', expect.any(Object), 'hpas'] })
  })
})
