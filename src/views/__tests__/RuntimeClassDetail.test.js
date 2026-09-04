import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, toValue } from 'vue'
import { i18n } from '@/i18n'

// 契约:集群级 RuntimeClass 详情页——Overview(handler/description/overhead)+ live YAML 编辑 + 删除。
// 与 IngressClassDetail 同构(同病同修):列表 name 死链 + 有损 generateYAML 展开行编辑的根治面。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchRuntimeClass: vi.fn(),
  deleteRuntimeClass: vi.fn(),
  applyYaml: vi.fn(async () => ({ ok: true })),
  captured: { opts: null, data: null, loading: { value: false } }, // vi.hoisted 先于 import 执行,不能用 ref()
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { name: 'kata' } }),
  useRouter: () => ({ push: h.push }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    fetchRuntimeClass: h.fetchRuntimeClass,
    deleteRuntimeClass: h.deleteRuntimeClass,
  }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: (opts) => {
    h.captured.opts = opts
    return { data: h.captured.data, isLoading: h.captured.loading }
  },
}))
vi.mock('@/composables/useLiveYaml', () => ({
  useLiveYaml: () => ({ yaml: ref('apiVersion: node.k8s.io/v1\nkind: RuntimeClass'), yamlLoading: ref(false), error: ref(''), reload: vi.fn() }),
}))
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: h.applyYaml }),
}))

import RuntimeClassDetail from '../RuntimeClassDetail.vue'

// 真实 API 形状:RuntimeClass 无 spec——handler/overhead/scheduling 全是顶层字段
const FIXTURE = {
  name: 'kata',
  handler: 'kata-runtime',
  age: '5d',
  labels: { runtime: 'sandboxed' },
  annotations: { 'node.k8s.io/some': 'value' },
  overhead: { podFixed: { memory: '120Mi', cpu: '250m' } },
  scheduling: { nodeSelector: { 'kubernetes.io/os': 'linux' } },
}

const ModalStub = { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }

function mountView() {
  return mount(RuntimeClassDetail, {
    global: { plugins: [i18n], stubs: { Modal: ModalStub, Breadcrumbs: true, YamlEditor: true } },
  })
}

describe('RuntimeClassDetail', () => {
  beforeEach(() => { // 用例共享 hoisted spy:清理防调用计数跨用例泄漏
    for (const spy of [h.push, h.fetchRuntimeClass, h.deleteRuntimeClass, h.applyYaml]) spy.mockClear()
  })
  it('数据接线:useResourceDetail key 指向 runtimeclasses 单资源,fetcher 走 store.fetchRuntimeClass', async () => {
    h.fetchRuntimeClass.mockResolvedValue(FIXTURE)
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    // vue-query 适配器在 useQuery 内部才 deep-unref key,mock 层拿到的 cid 仍是 computed——toValue 归一后断言
    expect(h.captured.opts.key.map(k => toValue(k))).toEqual(['cluster', 'c', 'runtimeclasses', 'kata'])
    const viaFetcher = await h.captured.opts.fetcher()
    expect(h.fetchRuntimeClass).toHaveBeenCalledWith('kata')
    expect(viaFetcher).toEqual(FIXTURE)
  })

  it('Overview:handler/overhead/scheduling 可见', async () => {
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    expect(w.text()).toContain('kata')
    expect(w.text()).toContain('kata-runtime')
    expect(w.text()).toContain('120Mi')
    expect(w.text()).toContain('kubernetes.io/os')
  })

  it('YAML tab:live yaml 进编辑器,save → applyYaml', async () => {
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    await w.findAll('button').find(b => b.text() === 'yaml').trigger('click')
    const editor = w.findComponent({ name: 'YamlEditor' })
    expect(editor.exists()).toBe(true)
    expect(editor.props('modelValue')).toContain('kind: RuntimeClass')
    editor.vm.$emit('save', 'kind: RuntimeClass\nmetadata:\n  name: kata')
    await w.vm.$nextTick()
    expect(h.applyYaml).toHaveBeenCalledTimes(1)
  })

  it('删除:确认后 store.deleteRuntimeClass(name) + 回列表', async () => {
    h.deleteRuntimeClass.mockResolvedValue({ ok: true })
    h.captured.data = ref(FIXTURE)
    const w = mountView()
    await w.vm.$nextTick()
    await w.find('[data-testid="detail-delete-btn"]').trigger('click')
    await w.find('[data-testid="detail-delete-confirm"]').trigger('click')
    expect(h.deleteRuntimeClass).toHaveBeenCalledWith('kata')
    expect(h.push).toHaveBeenCalledWith('/runtimeclasses')
  })

  it('not-found:对象为空时呈现回列表出口', async () => {
    h.captured.data = ref(undefined)
    const w = mountView()
    await w.vm.$nextTick()
    const back = w.find('[data-testid="back-to-list"]')
    expect(back.exists()).toBe(true)
    await back.trigger('click')
    expect(h.push).toHaveBeenCalledWith('/runtimeclasses')
  })
})
