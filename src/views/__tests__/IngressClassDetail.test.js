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
  { name: 'app1', namespace: 'web', className: 'nginx', hosts: 'a.com,b.com', tls: true, tlsHosts: ['a.com'], tlsSecret: 's', rules: [{ http: { paths: [{ backend: { service: { name: 'svc1', port: { number: 8080 } } } }] } }], defaultBackend: null, age: '1d' },
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

  it('关联 Ingress 摘要卡:紧凑(端口徽标+计数+hosts 上限),「查看全部」切 ingresses tab', async () => {
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    const card = w.find('[data-testid="related-ingresses"]')
    expect(card.text()).toContain('a.com:443')
    expect(card.text()).not.toContain('svc1:8080') // svc 聚合 chips 移入全宽 tab,右栏只留紧凑摘要
    const viewAll = w.find('[data-testid="related-view-all"]')
    expect(viewAll.exists()).toBe(true)
    await viewAll.trigger('click')
    await w.vm.$nextTick()
    expect(w.find('[data-testid="related-search"]').exists()).toBe(true) // 已在 ingresses tab
    const row = w.find('[data-testid="related-row"]')
    await row.trigger('click')
    expect(h.push).toHaveBeenCalledWith({ name: 'NsIngressDetail', params: { namespace: 'web', name: 'app1' } })
  })

  it('摘要 hosts 超上限:只渲染 8 个 + 「+N」点击切 tab', async () => {
    h.captured.data = ref(FIXTURE)
    const many = { ...RELATED[0], hosts: Array.from({ length: 10 }, (_, i) => `h${i}.com`).join(',') }
    h.captured.related = ref([{ ...many, tlsHosts: [] }])
    const w = mountView()
    await w.vm.$nextTick()
    const card = w.find('[data-testid="related-ingresses"]')
    expect(card.text()).toContain('h7.com:80')
    expect(card.text()).not.toContain('h8.com')
    const more = w.find('[data-testid="related-hosts-more"]')
    expect(more.text()).toContain('+2')
    await more.trigger('click')
    await w.vm.$nextTick()
    expect(w.find('[data-testid="related-search"]').exists()).toBe(true)
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

// 暴露摘要 + 明细优化(2026-09-05 第二轮):端口可见(80/443/host 级 TLS)、后端全量聚合、搜索过滤、折叠展开。
const R1 = { name: 'app1', namespace: 'web', className: 'nginx', hosts: 'a.com,b.com', tls: true, tlsHosts: ['a.com'], tlsSecret: 's', rules: [{ http: { paths: [{ backend: { service: { name: 'svc1', port: { number: 8080 } } } }, { backend: { service: { name: 'svc2', port: { number: 9090 } } } }] } }], defaultBackend: null, age: '1d' }
const R2 = { name: 'app2', namespace: 'api', className: 'nginx', hosts: 'b.com', tls: false, tlsHosts: [], rules: [{ http: { paths: [{ backend: { service: { name: 'svc1', port: { number: 8080 } } } }] } }], defaultBackend: { serviceName: 'svc-default', servicePort: '80' }, age: '2d' }

describe('IngressClassDetail 暴露摘要与明细', () => {
  // 第三轮:明细迁独立全宽 tab(overview 右栏只留紧凑摘要);行单行化。
  const openTab = async (w) => {
    await w.findAll('button').find(b => b.text().startsWith('ingresses')).trigger('click')
    await w.vm.$nextTick()
  }

  beforeEach(() => {
    h.push.mockClear()
    h.captured.related = ref([R1, R2])
    h.captured.data = ref(FIXTURE)
  })

  it('摘要卡(Overview 右栏):80/443 徽标 + 计数(svc 数保留在计数,聚合 chips 在 tab)', async () => {
    const w = mountView()
    await w.vm.$nextTick()
    const s = w.find('[data-testid="exposure-summary"]')
    expect(s.exists()).toBe(true)
    expect(s.text()).toContain(':443')   // a.com 走 TLS
    expect(s.text()).toContain(':80')    // b.com 纯 HTTP
    expect(s.find('[data-testid="exposure-stats"]').attributes('data-counts')).toBe('2|2|3') // 2 Ingress / hosts 去重 {a.com,b.com} / svc 去重 {svc1:8080,svc2:9090,svc-default:80}
  })

  it('tab 标签:ingresses tab 带引用计数', async () => {
    const w = mountView()
    await w.vm.$nextTick()
    const tab = w.findAll('button').find(b => b.text() === 'ingresses (2)')
    expect(tab).toBeTruthy()
  })

  it('明细行:渲染该条全部后端(不只首条)', async () => {
    const w = mountView()
    await openTab(w)
    const row = w.findAll('[data-testid="related-row"]').find(r => r.text().includes('app1'))
    expect(row.text()).toContain('svc1:8080')
    expect(row.text()).toContain('svc2:9090')
  })

  it('host 级端口:TLS host 带 443,纯 HTTP host 带 80', async () => {
    const w = mountView()
    await openTab(w)
    const row = w.findAll('[data-testid="related-row"]').find(r => r.text().includes('app1'))
    expect(row.text()).toContain('a.com:443')
    expect(row.text()).toContain('b.com:80')
  })

  it('搜索:按 namespace/host/服务名过滤明细', async () => {
    const w = mountView()
    await openTab(w)
    await w.find('[data-testid="related-search"]').setValue('api')
    expect(w.findAll('[data-testid="related-row"]').length).toBe(1)
    expect(w.text()).toContain('app2')
    await w.find('[data-testid="related-search"]').setValue('svc2')
    const rows = w.findAll('[data-testid="related-row"]')
    expect(rows.length).toBe(1)
    expect(rows[0].text()).toContain('app1')
  })

  it('折叠:>5 条默认显示 5 条 + 展开钮;展开/收起可控', async () => {
    h.captured.related = ref(Array.from({ length: 7 }, (_, i) => ({ ...R1, name: `app${i}`, namespace: 'web' })))
    const w = mountView()
    await openTab(w)
    expect(w.findAll('[data-testid="related-row"]').length).toBe(5)
    const expand = w.find('[data-testid="related-expand"]')
    expect(expand.text()).toContain('7')
    await expand.trigger('click')
    expect(w.findAll('[data-testid="related-row"]').length).toBe(7)
    await w.find('[data-testid="related-collapse"]').trigger('click')
    expect(w.findAll('[data-testid="related-row"]').length).toBe(5)
  })
})
