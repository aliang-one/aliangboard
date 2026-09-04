import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// 回归:header 默认钮——非默认显示「设为默认」(promoteStorageClassDefault),已是默认显示「取消默认」(updateStorageClass isDefault:false)。
const updateSpy = vi.fn()
const promoteSpy = vi.fn()
let scFixture = null

vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: () => ({ data: ref(scFixture) }),
  useResourceList: () => ({ data: ref([]) }),
}))
vi.mock('@/composables/useLiveYaml', () => ({ useLiveYaml: () => ({ yaml: ref('') }) }))
vi.mock('@/composables/useResourceApply', () => ({ useResourceApply: () => ({ applyYaml: vi.fn() }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    fetchStorageClass: vi.fn(),
    deleteStorageClass: vi.fn(),
    fetchPVCs: vi.fn(),
    updateStorageClass: updateSpy,
    promoteStorageClassDefault: promoteSpy,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { name: 'fast-sc' } }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

import StorageClassDetail from '../StorageClassDetail.vue'

// modelValue 条件渲染:让「弹窗是否还开着」可从 DOM 断言(saveEdit 失败守卫测试依赖)
const ModalStub = { name: 'Modal', props: ['modelValue'], template: '<div v-if="modelValue" data-testid="modal-open"><slot/><slot name="actions"/></div>' }

function mountView() {
  return mount(StorageClassDetail, {
    global: { mocks: { $t: (k) => k }, stubs: { Modal: ModalStub, Breadcrumbs: true, YamlEditor: true } },
  })
}
const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

function makeSc(isDefault) {
  return { name: 'fast-sc', default: isDefault, provisioner: 'x', reclaimPolicy: 'Delete', age: '5d', labels: {}, annotations: {}, parameters: '' }
}

describe('StorageClassDetail 默认钮', () => {
  beforeEach(() => {
    updateSpy.mockClear()
    promoteSpy.mockClear()
  })

  it('非默认:显示「设为默认」,点击调 promoteStorageClassDefault(name)', async () => {
    scFixture = makeSc(false)
    const w = mountView()
    await flush()
    const btn = w.find('[data-testid="promote-default-btn"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flush()
    expect(promoteSpy).toHaveBeenCalledWith('fast-sc')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('已是默认:显示「取消默认」,点击调 updateStorageClass(name, { isDefault: false })', async () => {
    scFixture = makeSc(true)
    const w = mountView()
    await flush()
    const btn = w.find('[data-testid="demote-default-btn"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flush()
    expect(updateSpy).toHaveBeenCalledWith('fast-sc', { isDefault: false })
    expect(promoteSpy).not.toHaveBeenCalled()
  })

  it('saveEdit: updateStorageClass 返回 {ok:false} → 编辑弹窗不关闭', async () => {
    scFixture = makeSc(false)
    updateSpy.mockResolvedValueOnce({ ok: false, error: 'sweep failed' })
    const w = mountView()
    await flush()
    const editBtn = w.findAll('button').find(b => b.text().includes('common.edit'))
    expect(editBtn).toBeTruthy()
    await editBtn.trigger('click')
    await flush()
    expect(w.find('[data-testid="modal-open"]').exists()).toBe(true)
    const saveBtn = w.findAll('button').find(b => b.text().includes('common.save'))
    await saveBtn.trigger('click')
    await flush()
    expect(updateSpy).toHaveBeenCalled()
    expect(w.find('[data-testid="modal-open"]').exists()).toBe(true) // 失败:保留弹窗
  })

  it('saveEdit: updateStorageClass 成功 → 编辑弹窗关闭', async () => {
    scFixture = makeSc(false)
    updateSpy.mockResolvedValueOnce(undefined)
    const w = mountView()
    await flush()
    await w.findAll('button').find(b => b.text().includes('common.edit')).trigger('click')
    await flush()
    const saveBtn = w.findAll('button').find(b => b.text().includes('common.save'))
    await saveBtn.trigger('click')
    await flush()
    expect(w.find('[data-testid="modal-open"]').exists()).toBe(false)
  })
})
