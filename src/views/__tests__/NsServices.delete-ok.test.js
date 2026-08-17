import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// === 回归(2026-08-17 「删了 service,跳回列表还能看到」) ===
// 根因不是数据不同步(Vue Query 端到端链路已由 stores/services.delete-invalidation.test.js 证明健康):
// 是集群 SA 无 delete 权限(403)时,store.deleteService 返 {ok:false} 并 toast,
// 但两个视图的 handleDelete 均不检查 {ok} —— 详情页照样 router.push 跳列表(像删成功了)、
// 列表页照样关确认框。用户看到「删了但还在」,误判为数据模型问题。
// 契约:删除成功才跳转/关框;失败留在原地(store 已 toast 错误)。

const pushSpy = vi.fn()
const invalidateSpy = vi.fn()
let deleteResult = { ok: true }
const deleteService = vi.fn(async () => deleteResult)

const SVC = {
  name: 'svc-a', namespace: 'anydoor', type: 'ClusterIP', clusterIP: '10.0.0.1', clusterIPs: ['10.0.0.1'],
  externalIP: '-', externalIPs: [], externalName: '', ports: '80:8080/TCP',
  portList: [{ name: '', port: 80, targetPort: 8080, protocol: 'TCP', nodePort: null, appProtocol: '' }],
  selector: { app: 'svc-a' }, sessionAffinity: 'None', sessionAffinityTimeout: undefined,
  externalTrafficPolicy: '', internalTrafficPolicy: 'Cluster', ipFamilyPolicy: '', ipFamilies: [],
  publishNotReadyAddresses: false, uid: 'uid-a',
}

const mockStore = () => ({
  currentCluster: 'c',
  setNamespace: vi.fn(),
  fetchService: vi.fn(async () => SVC),
  fetchServices: vi.fn(async () => [SVC]),
  fetchPods: vi.fn(async () => []),
  fetchWorkloads: vi.fn(async () => []),
  fetchEvents: vi.fn(async () => []),
  fetchEndpoints: vi.fn(async () => []),
  updateService: vi.fn(async () => ({ ok: true })),
  deleteService,
  checkAccessServer: vi.fn(async () => ({ ok: true, allowed: true })),
})
vi.mock('@/stores/cluster', () => ({ useClusterStore: mockStore }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: () => ({ data: { value: SVC } }),
  // services 列表给数据;endpoints/workloads/pods/events 给 [](详情页 ep.ports 须为数组或缺席)
  useResourceList: ({ key }) => ({ data: { value: key?.[2] === 'services' ? [SVC] : [] } }),
}))
vi.mock('@/composables/useResourceApply', () => ({ useResourceApply: () => ({ applyYaml: vi.fn() }) }))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({})), applyYaml: vi.fn(async () => ({ resources: [], applied: [], failed: [], total: 0 })) },
  exportYaml: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@tanstack/vue-query', () => ({ useQueryClient: () => ({ invalidateQueries: invalidateSpy }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'anydoor', name: 'svc-a' }, name: 'NsServiceDetail', path: '/ns/anydoor/services/svc-a' }),
  useRouter: () => ({ push: pushSpy }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (k) => k } } }))

const NsServiceDetail = (await import('../NsServiceDetail.vue')).default
const NsServices = (await import('../NsServices.vue')).default

// Modal:受 modelValue 控制,内联渲染 default+actions 槽(真 Modal 走 Teleport)
const ModalStub = { props: ['modelValue', 'title'], template: '<div v-if="modelValue" class="modal"><slot/><slot name="actions"/></div>' }
// DropdownMenu:拍平成按钮,便于点击触发 item.action
const DropdownStub = { props: ['items'], template: '<div><button v-for="(it,i) in items" :key="i" class="menu-item" @click="it.action">{{ it.label }}</button></div>' }

const stubs = { Modal: ModalStub, DropdownMenu: DropdownStub, Breadcrumbs: true, StatusChip: true, PodCard: true, YamlEditor: true, PortSelect: true, PortForwardPanel: true, Pagination: true, DataTable: false }

beforeEach(() => {
  pushSpy.mockClear()
  invalidateSpy.mockClear()
  deleteService.mockClear()
})

describe('NsServiceDetail 删除须尊重 {ok}:失败不跳列表', () => {
  it('deleteService {ok:false}(如 SA 无权限 403)→ 不 router.push,确认框保留', async () => {
    deleteResult = { ok: false }
    const w = mount(NsServiceDetail, { global: { mocks: { $t: k => k }, stubs } })
    await flushPromises()
    // 打开 ⋮ 菜单里的 Delete Service → 确认框出现
    await w.findAll('button.menu-item').find(b => b.text() === 'Delete Service').trigger('click')
    expect(w.find('.modal').exists()).toBe(true)
    // 点确认删除
    await w.findAll('button').find(b => b.text() === 'Delete').trigger('click')
    await flushPromises()
    expect(deleteService).toHaveBeenCalledWith('svc-a', 'anydoor')
    expect(pushSpy).not.toHaveBeenCalled()
    expect(w.find('.modal').exists()).toBe(true) // 确认框保留:让用户看到没删成
  })

  it('deleteService {ok:true} → 跳回 NsServices 列表', async () => {
    deleteResult = { ok: true }
    const w = mount(NsServiceDetail, { global: { mocks: { $t: k => k }, stubs } })
    await flushPromises()
    await w.findAll('button.menu-item').find(b => b.text() === 'Delete Service').trigger('click')
    await w.findAll('button').find(b => b.text() === 'Delete').trigger('click')
    await flushPromises()
    expect(pushSpy).toHaveBeenCalledWith({ name: 'NsServices', params: { namespace: 'anydoor' } })
  })
})

describe('NsServices 列表删除须尊重 {ok}:失败不关确认框', () => {
  it('deleteService {ok:false} → 确认框保留(不当作已删)', async () => {
    deleteResult = { ok: false }
    const w = mount(NsServices, { global: { mocks: { $t: k => k }, stubs } })
    await flushPromises()
    // 行操作菜单 → Delete
    await w.findAll('button.menu-item').find(b => b.text() === 'ns.services.menuDelete').trigger('click')
    expect(w.find('.modal').exists()).toBe(true)
    await w.findAll('button').find(b => b.text() === 'common.delete').trigger('click')
    await flushPromises()
    expect(deleteService).toHaveBeenCalledWith('svc-a', 'anydoor')
    expect(w.find('.modal').exists()).toBe(true) // 失败:确认框保留
  })

  it('deleteService {ok:true} → 关确认框 + invalidate services 查询', async () => {
    deleteResult = { ok: true }
    const w = mount(NsServices, { global: { mocks: { $t: k => k }, stubs } })
    await flushPromises()
    await w.findAll('button.menu-item').find(b => b.text() === 'ns.services.menuDelete').trigger('click')
    await w.findAll('button').find(b => b.text() === 'common.delete').trigger('click')
    await flushPromises()
    expect(w.find('.modal').exists()).toBe(false)
    expect(invalidateSpy).toHaveBeenCalled()
  })
})
