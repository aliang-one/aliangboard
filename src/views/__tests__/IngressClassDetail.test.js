import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, toValue } from 'vue'
import { i18n } from '@/i18n'

// 契约:集群级 IngressClass 详情页——Overview(含 spec.parameters 可见性)+ live YAML 编辑 + 删除。
// 有损背景:generateYAML('ingressclass') 只重建 3 字段,真实控制器的 parameters/labels 会被
// force apply 静默剪掉——详情页 YAML 必须走 useLiveYaml(实时完整对象),Overview 必须展示 parameters。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchIngressClass: vi.fn(),
  deleteIngressClass: vi.fn(),
  fetchIngresses: vi.fn(),
  promoteIngressClassDefault: vi.fn(),
  demoteIngressClassDefault: vi.fn(),
  updateIngressClassSpec: vi.fn(),
  applyYaml: vi.fn(async () => ({ ok: true })),
  captured: { opts: null, data: null, related: null, loading: { value: false } }, // vi.hoisted 先于 import 执行,不能用 ref()
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { name: 'nginx' } }),
  useRouter: () => ({ push: h.push }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    fetchIngressClass: h.fetchIngressClass,
    deleteIngressClass: h.deleteIngressClass,
    fetchIngresses: h.fetchIngresses,
    promoteIngressClassDefault: h.promoteIngressClassDefault,
    demoteIngressClassDefault: h.demoteIngressClassDefault,
    updateIngressClassSpec: h.updateIngressClassSpec,
  }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: (opts) => {
    h.captured.opts = opts
    return { data: h.captured.data, isLoading: h.captured.loading }
  },
  useResourceList: () => ({ data: h.captured.related }),
}))
vi.mock('@/composables/useLiveYaml', () => ({
  useLiveYaml: () => ({ yaml: ref('apiVersion: networking.k8s.io/v1\nkind: IngressClass'), yamlLoading: ref(false), error: ref(''), reload: vi.fn() }),
}))
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: h.applyYaml }),
}))

import IngressClassDetail from '../IngressClassDetail.vue'

const FIXTURE = {
  name: 'nginx',
  controller: 'k8s.io/ingress-nginx',
  isDefault: true,
  age: '30d',
  labels: { team: 'edge' },
  annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
  parameters: { apiGroup: 'k8s.example.com', kind: 'NginxConfiguration', name: 'nginx-config' },
}

const RELATED = [
  { name: 'app1', namespace: 'web', className: 'nginx', hosts: 'a.com,b.com', tls: true, tlsSecret: 's', rules: [{ http: { paths: [{ backend: { service: { name: 'svc1', port: { number: 8080 } } } }] } }], defaultBackend: null, age: '1d' },
]

// Modal 用 Teleport,stub 成内联渲染 default+actions 槽
const ModalStub = { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }

function mountView() {
  return mount(IngressClassDetail, {
    global: { plugins: [i18n], stubs: { Modal: ModalStub, Breadcrumbs: true, YamlEditor: true } },
  })
}

describe('IngressClassDetail', () => {
  beforeEach(() => { // 用例共享 hoisted spy:清理防调用计数跨用例泄漏
    for (const spy of [h.push, h.fetchIngressClass, h.deleteIngressClass, h.fetchIngresses, h.promoteIngressClassDefault, h.demoteIngressClassDefault, h.updateIngressClassSpec, h.applyYaml]) spy.mockClear()
    h.captured.related = ref([RELATED[0]])
  })
  it('数据接线:useResourceDetail key 指向 ingressclasses 单资源,fetcher 走 store.fetchIngressClass', async () => {
    h.fetchIngressClass.mockResolvedValue(FIXTURE)
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    // vue-query 适配器在 useQuery 内部才 deep-unref key,mock 层拿到的 cid 仍是 computed——toValue 归一后断言
    expect(h.captured.opts.key.map(k => toValue(k))).toEqual(['cluster', 'c', 'ingressclasses', 'nginx'])
    const viaFetcher = await h.captured.opts.fetcher()
    expect(h.fetchIngressClass).toHaveBeenCalledWith('nginx')
    expect(viaFetcher).toEqual(FIXTURE)
  })

  it('Overview:header 展示 name/controller/Default 徽标,parameters 三元组可见', async () => {
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    expect(w.text()).toContain('nginx')
    expect(w.text()).toContain('k8s.io/ingress-nginx')
    expect(w.text()).toContain('NginxConfiguration')
    expect(w.text()).toContain('nginx-config')
    expect(w.text()).toContain('team') // labels 可见
  })

  it('YAML tab:live yaml 进编辑器,save → applyYaml(不经有损 generateYAML)', async () => {
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    await w.findAll('button').find(b => b.text() === 'yaml').trigger('click')
    const editor = w.findComponent({ name: 'YamlEditor' })
    expect(editor.exists()).toBe(true)
    expect(editor.props('modelValue')).toContain('kind: IngressClass')
    editor.vm.$emit('save', 'kind: IngressClass\nmetadata:\n  name: nginx')
    await w.vm.$nextTick()
    expect(h.applyYaml).toHaveBeenCalledTimes(1)
    expect(h.applyYaml.mock.calls[0][0]).toContain('kind: IngressClass')
  })

  it('删除:确认后 store.deleteIngressClass(name) + 回列表', async () => {
    h.deleteIngressClass.mockResolvedValue({ ok: true })
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-delete-btn"]').trigger('click')
    await w.find('[data-testid="detail-delete-confirm"]').trigger('click')
    expect(h.deleteIngressClass).toHaveBeenCalledWith('nginx')
    expect(h.push).toHaveBeenCalledWith('/ingressclasses')
  })

  it('header:非默认显示「设为默认」,点击调 promoteIngressClassDefault', async () => {
    h.promoteIngressClassDefault.mockResolvedValue({ ok: true })
    h.captured.data = ref({ ...FIXTURE, isDefault: false })
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="promote-default-btn"]').trigger('click')
    expect(h.promoteIngressClassDefault).toHaveBeenCalledWith('nginx')
  })

  it('header:已是默认显示「取消默认」,点击调 demote', async () => {
    h.demoteIngressClassDefault.mockResolvedValue({ ok: true })
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    expect(w.find('[data-testid="demote-default-btn"]').exists()).toBe(true)
    await w.find('[data-testid="demote-default-btn"]').trigger('click')
    expect(h.demoteIngressClassDefault).toHaveBeenCalledWith('nginx')
  })

  it('关联 Ingress 面板:计数/hosts/443/svc:port/点击跳转', async () => {
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    const card = w.find('[data-testid="related-ingresses"]')
    expect(card.text()).toContain('a.com')
    expect(card.text()).toContain('svc1:8080')
    const row = card.find('button')
    await row.trigger('click')
    expect(h.push).toHaveBeenCalledWith({ name: 'NsIngressDetail', params: { namespace: 'web', name: 'app1' } })
  })

  it('关联 Ingress 空态:无引用时渲染空态文案', async () => {
    h.captured.data = ref(FIXTURE)
    h.captured.related = ref([])
    const w = mountView()
    await w.vm.$nextTick()
    const card = w.find('[data-testid="related-ingresses"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain(i18n.global.t('admin.ingressClasses.relatedEmpty'))
  })

  it('not-found:对象为空时呈现回列表出口', async () => {
    h.captured.data = ref(undefined)
    const w = mountView()
    await w.vm.$nextTick()
    const back = w.find('[data-testid="back-to-list"]')
    expect(back.exists()).toBe(true)
    await back.trigger('click')
    expect(h.push).toHaveBeenCalledWith('/ingressclasses')
  })
})

// 结构化编辑弹窗(2026-09-05):controller/parameters/labels/annotations 走 updateIngressClassSpec 手术 patch;
// isDefault 开关走 promote/demote(sweep 唯一性),不进 patch。
describe('IngressClassDetail 结构化编辑', () => {
  beforeEach(() => {
    for (const spy of [h.push, h.fetchIngressClass, h.promoteIngressClassDefault, h.demoteIngressClassDefault, h.updateIngressClassSpec]) spy.mockClear()
    h.captured.related = ref([RELATED[0]])
    h.captured.data = ref(FIXTURE)
    h.updateIngressClassSpec.mockResolvedValue({ ok: true })
  })

  it('编辑钮打开弹窗,字段按当前对象回显(controller/parameters 启用三元组/labels 行)', async () => {
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-edit-btn"]').trigger('click')
    expect(w.find('[data-testid="edit-controller"]').element.value).toBe('k8s.io/ingress-nginx')
    expect(w.find('[data-testid="edit-params-enable"]').element.checked).toBe(true)
    expect(w.find('[data-testid="edit-params-kind"]').element.value).toBe('NginxConfiguration')
    expect(w.find('[data-testid="edit-params-name"]').element.value).toBe('nginx-config')
    expect(w.find('[data-testid="edit-params-apigroup"]').element.value).toBe('k8s.example.com')
    expect(w.text()).toContain('team') // labels 行回显
  })

  it('保存:controller 改动 + 未变字段全量传 → updateIngressClassSpec 手术 diff(annotations 排除 is-default 键)', async () => {
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-edit-btn"]').trigger('click')
    await w.find('[data-testid="edit-controller"]').setValue('k8s.io/other')
    await w.find('[data-testid="edit-save"]').trigger('click')
    await w.vm.$nextTick()
    expect(h.updateIngressClassSpec).toHaveBeenCalledTimes(1)
    const payload = h.updateIngressClassSpec.mock.calls[0][1]
    expect(payload.controller).toBe('k8s.io/other')
    expect(payload.parameters).toEqual(FIXTURE.parameters) // 未动 → 原样传,diff 层判定无变化
    expect(payload.labels).toEqual({ team: 'edge' })
    expect(payload.annotations).toEqual({}) // 唯一注解是 is-default 键,表单排除后为空
    expect(payload.isDefault).toBeUndefined() // 默认态不进 spec patch
  })

  it('关闭 parameters 开关保存 → payload.parameters = null(整体删除)', async () => {
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-edit-btn"]').trigger('click')
    await w.find('[data-testid="edit-params-enable"]').setValue(false)
    await w.find('[data-testid="edit-save"]').trigger('click')
    await w.vm.$nextTick()
    expect(h.updateIngressClassSpec.mock.calls[0][1].parameters).toBeNull()
  })

  it('isDefault 开关变更 → 保存走 demote(sweep),spec patch 不含默认注解', async () => {
    h.demoteIngressClassDefault.mockResolvedValue({ ok: true })
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-edit-btn"]').trigger('click')
    await w.find('[data-testid="edit-is-default"]').setValue(false)
    await w.find('[data-testid="edit-save"]').trigger('click')
    await w.vm.$nextTick()
    expect(h.updateIngressClassSpec).toHaveBeenCalledTimes(1)
    expect(h.demoteIngressClassDefault).toHaveBeenCalledWith('nginx')
    expect(h.updateIngressClassSpec.mock.calls[0][1].isDefault).toBeUndefined()
  })

  it('spec 保存失败({ok:false})→ 提前返回,不触发默认态切换', async () => {
    h.updateIngressClassSpec.mockResolvedValue({ ok: false, error: 'x' })
    h.demoteIngressClassDefault.mockResolvedValue({ ok: true })
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-edit-btn"]').trigger('click')
    await w.find('[data-testid="edit-is-default"]').setValue(false)
    await w.find('[data-testid="edit-save"]').trigger('click')
    await w.vm.$nextTick()
    expect(h.demoteIngressClassDefault).not.toHaveBeenCalled()
  })
})
