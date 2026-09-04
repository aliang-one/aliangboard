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
  applyYaml: vi.fn(async () => ({ ok: true })),
  captured: { opts: null, data: null, loading: { value: false } }, // vi.hoisted 先于 import 执行,不能用 ref()
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
  }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: (opts) => {
    h.captured.opts = opts
    return { data: h.captured.data, isLoading: h.captured.loading }
  },
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

// Modal 用 Teleport,stub 成内联渲染 default+actions 槽
const ModalStub = { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }

function mountView() {
  return mount(IngressClassDetail, {
    global: { plugins: [i18n], stubs: { Modal: ModalStub, Breadcrumbs: true, YamlEditor: true } },
  })
}

describe('IngressClassDetail', () => {
  beforeEach(() => { // 用例共享 hoisted spy:清理防调用计数跨用例泄漏
    for (const spy of [h.push, h.fetchIngressClass, h.deleteIngressClass, h.applyYaml]) spy.mockClear()
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
