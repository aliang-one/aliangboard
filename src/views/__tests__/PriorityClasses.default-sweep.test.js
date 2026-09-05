import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// 契约(2026-09-05 审计):创建勾选 globalDefault → 先以 false 创建,成功后走
// promotePriorityClassDefault(sweep 其他 globalDefault 再置 true);创建/任一失败保留弹窗。
const h = vi.hoisted(() => ({
  fetchPriorityClasses: vi.fn(async () => []),
  addPriorityClass: vi.fn(async () => ({ ok: true })),
  promotePriorityClassDefault: vi.fn(async () => ({ ok: true })),
  deletePriorityClass: vi.fn(async () => ({ ok: true })),
  generateExtraYAML: vi.fn(() => 'kind: PriorityClass'),
}))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn() },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    setNamespace: () => {},
    fetchPriorityClasses: h.fetchPriorityClasses,
    addPriorityClass: h.addPriorityClass,
    promotePriorityClassDefault: h.promotePriorityClassDefault,
    deletePriorityClass: h.deletePriorityClass,
    generateExtraYAML: h.generateExtraYAML,
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: vi.fn() }) }))

import PriorityClasses from '../PriorityClasses.vue'

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(PriorityClasses, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: { Modal: { template: '<div><slot/><slot name="actions"/></div>' }, Breadcrumbs: true, YamlEditor: true, Pagination: true },
    },
  })
}

async function driveCreate(w, { globalDefault }) {
  await w.find('[data-testid="pc-create-name"]').setValue('new-pc')
  if (globalDefault) await w.find('[data-testid="pc-create-global-default"]').setValue(true)
  const btn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('admin.priorityClasses.create')) // 精确匹配弹窗确认钮,避开工具栏 Create PriorityClass
  await btn.trigger('click')
  await flushPromises()
}

describe('PriorityClasses 创建 globalDefault sweep', () => {
  beforeEach(() => {
    h.addPriorityClass.mockClear().mockResolvedValue({ ok: true })
    h.promotePriorityClassDefault.mockClear().mockResolvedValue({ ok: true })
  })

  it('勾选 globalDefault:创建 payload 为 false,promote 承担置默认(sweep 语义)', async () => {
    const w = mountView()
    await flushPromises()
    await driveCreate(w, { globalDefault: true })
    expect(h.addPriorityClass).toHaveBeenCalledTimes(1)
    expect(h.addPriorityClass.mock.calls[0][0].globalDefault).toBe(false)
    expect(h.promotePriorityClassDefault).toHaveBeenCalledWith('new-pc')
  })

  it('不勾选:创建 true 语义不出现,promote 不被调', async () => {
    const w = mountView()
    await flushPromises()
    await driveCreate(w, { globalDefault: false })
    expect(h.addPriorityClass.mock.calls[0][0].globalDefault).toBe(false)
    expect(h.promotePriorityClassDefault).not.toHaveBeenCalled()
  })

  it('创建失败:保留弹窗语义(promote 不被调)', async () => {
    h.addPriorityClass.mockResolvedValue({ ok: false })
    const w = mountView()
    await flushPromises()
    await driveCreate(w, { globalDefault: true })
    expect(h.promotePriorityClassDefault).not.toHaveBeenCalled()
  })

  it('promote 失败:不重置表单(保留弹窗供重试)', async () => {
    h.promotePriorityClassDefault.mockResolvedValue({ ok: false })
    const w = mountView()
    await flushPromises()
    await driveCreate(w, { globalDefault: true })
    expect(h.promotePriorityClassDefault).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="pc-create-name"]').element.value).toBe('new-pc') // resetCreate 未执行
  })
})
