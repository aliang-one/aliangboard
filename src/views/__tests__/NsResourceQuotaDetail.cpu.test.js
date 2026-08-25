import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// 回归:limits.cpu 编辑往返——加载按毫核回显("20"→20000)、保存发 "20000m"。
const updateSpy = vi.fn()
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: () => ({ data: ref({ name: 'rq1', namespace: 'anydoor', hard: { 'limits.cpu': '20' }, used: {} }) }),
}))
vi.mock('@/composables/useLiveYaml', () => ({ useLiveYaml: () => ({ yaml: ref('') }) }))
vi.mock('@/composables/useResourceApply', () => ({ useResourceApply: () => ({ applyYaml: vi.fn() }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c', setNamespace: vi.fn(),
    fetchResourceQuota: vi.fn(), getResourceQuotaByName: () => null,
    updateResourceQuota: updateSpy,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'anydoor', name: 'rq1' } }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

import NsResourceQuotaDetail from '../NsResourceQuotaDetail.vue'

// Modal 用 Teleport,stub 成内联渲染 default+actions 槽
const ModalStub = { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }

function mountView() {
  return mount(NsResourceQuotaDetail, {
    global: { mocks: { $t: (k) => k }, stubs: { Modal: ModalStub, Breadcrumbs: true, YamlEditor: true, ProgressBar: true } },
  })
}
const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

describe('NsResourceQuotaDetail CPU 毫核往返', () => {
  it('打开编辑:limits.cpu="20" → 输入框回显 20000', async () => {
    const w = mountView()
    await flush()
    const editBtn = w.findAll('button').find(b => b.text().includes('common.edit'))
    await editBtn.trigger('click')
    const cpuInput = w.find('input[placeholder="20000"]')
    expect(cpuInput.exists()).toBe(true)
    expect(cpuInput.element.value).toBe('20000')
  })

  it('保存:输入 20000 → updateResourceQuota 收到 limits.cpu="20000m"', async () => {
    updateSpy.mockClear()
    const w = mountView()
    await flush()
    const editBtn = w.findAll('button').find(b => b.text().includes('common.edit'))
    await editBtn.trigger('click')
    const cpuInput = w.find('input[placeholder="20000"]')
    await cpuInput.setValue('20000')
    const saveBtn = w.findAll('button').find(b => b.text().includes('common.saveChanges'))
    await saveBtn.trigger('click')
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const arg = updateSpy.mock.calls.at(-1)[2]
    expect(arg.hard['limits.cpu']).toBe('20000m')
  })
})
