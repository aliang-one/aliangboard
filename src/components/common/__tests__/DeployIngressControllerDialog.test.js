import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// vi.mock 被 vitest 提升(hoist)到文件顶部,普通 const 在 mock 工厂内不可见;
// 用 vi.hoisted 让 mock 工厂能引用同一个 spy(RBAC 测试要断言调用次数)。
// fetchIngressClassesMock 默认返回空数组(未安装);个别测试用 mockReturnValueOnce 注入已安装类。
const { checkAccessMock, fetchIngressClassesMock } = vi.hoisted(() => ({
  checkAccessMock: vi.fn(async () => ({ allowed: true })),
  fetchIngressClassesMock: vi.fn(async () => []),
}))

vi.mock('@/api/client', () => ({
  api: {
    ingressControllers: {
      catalog: vi.fn(async () => ({ templates: [
        { id: 'nginx-ingress', labelKey: 'ingressController.nginx-ingress.label', descKey: 'ingressController.nginx-ingress.desc', notesKey: 'ingressController.nginx-ingress.notes', version: 'v1', variant: 'bare-metal', controller: 'k8s.io/ingress-nginx', defaultClassName: 'nginx' },
      ] })),
      manifest: vi.fn(async () => ({ yaml: 'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: nginx\n' })),
    },
    // Task 5:组件直接调 api.applyYaml(顶层),不走 ingressControllers.applyYaml。
    applyYaml: vi.fn(async () => ({ applied: [], failed: [], total: 0 })),
    k8s: vi.fn(async () => ({ status: { allowed: true } })),
  },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    checkAccessServer: checkAccessMock,
    fetchIngressClasses: fetchIngressClassesMock,
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployIngressControllerDialog from '../DeployIngressControllerDialog.vue'

// Modal 会 Teleport 到 body,交互测试里用不 Teleport 的桩替换,便于 wrapper.find(沿用 CreatePvcDialog 约定)。
const ModalStub = {
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue', 'confirm', 'cancel'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
}

function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployIngressControllerDialog, {
    props: { modelValue: true },
    global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: ModalStub } },
  })
}

test('打开即拉 catalog 并渲染控制器卡片', async () => {
  const w = mountDlg()
  await flushPromises()
  // 不依赖 i18n 回退文本(labelKey 未翻译时恰好含 'nginx-ingress' 子串,Task 6 加翻译后会失效);
  // 改用稳定的 testid + 非 i18n 字段(version/variant)断言卡片已渲染。
  expect(w.find('[data-testid="controller-card"]').exists()).toBe(true)
  expect(w.text()).toContain('v1 · bare-metal')
})

test('选控制器后 manifest(id) 被正确调用一次', async () => {
  const { api } = await import('@/api/client')
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  expect(api.ingressControllers.manifest).toHaveBeenCalledWith('nginx-ingress')
  expect(api.ingressControllers.manifest).toHaveBeenCalledTimes(1)
})

// ===== Task 5: RBAC 预检 + apply 进度 + applied emit =====
// 注:Task 6 才补 ingressController.* i18n 键,故此处不断言翻译文案(会拿到回退的原始 key 路径),
// 改用稳定的 testid + mock 调用次数断言。

test('RBAC 预检: 选控制器后自动跑 9 次 SelfSubjectAccessReview 并渲染 testid', async () => {
  checkAccessMock.mockClear()
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()   // pick → checkRbac 完成
  // REQUIRED_RBAC 9 项 cluster-scoped 资源,verb=create, namespace=''
  expect(checkAccessMock).toHaveBeenCalledTimes(9)
  // T5-m1: 锁定 cluster-scoped 语义(verb=create, namespace='')
  expect(checkAccessMock.mock.calls[0][0]).toMatchObject({ verb: 'create', namespace: '' })
  // 预检结果块渲染(i18n 未翻译时显示原始 key 路径,testid 仍稳定)
  expect(w.find('[data-testid="rbac-check"]').exists()).toBe(true)
})

test('apply: 回 applied/failed/total,有成功则 emit applied + 进度摘要', async () => {
  const { api } = await import('@/api/client')
  api.applyYaml = vi.fn(async () => ({ applied: [{ kind: 'Namespace', name: 'x' }], failed: [], total: 1 }))
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="deploy-btn"]').trigger('click')
  await flushPromises()
  expect(api.applyYaml).toHaveBeenCalled()
  expect(w.emitted().applied).toBeTruthy()
  expect(w.text()).toContain('1/1')   // 进度摘要(非 i18n)
  // 全成功(failed 空)→ 关弹窗(update:modelValue false)+ 成功 toast 路径
  const closes = w.emitted()['update:modelValue']
  expect(closes?.[closes.length - 1]).toEqual([false])
})

// 成功反馈缺口(真实使用反馈:200 后"没反应"):部分失败 → 不关弹窗,进度 + failed 明细可见
test('apply 部分失败: 不关弹窗,渲染 ok/total 进度 + failed 明细', async () => {
  const { api } = await import('@/api/client')
  api.applyYaml = vi.fn(async () => ({
    applied: [{ kind: 'Namespace', name: 'x' }, { kind: 'ServiceAccount', name: 'y' }],
    failed: [{ kind: 'Role', name: 'r', error: 'rbac boom' }],
    total: 3,
  }))
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="deploy-btn"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('2/3')
  expect(w.text()).toContain('rbac boom')
  expect(w.emitted()['update:modelValue']).toBeUndefined()   // 部分失败不关窗
})

// T5-m2: result.applied/failed 为 undefined 时不崩(null-guard)
test('apply: 服务端返回缺 applied/failed 字段时不崩(progress 块渲染 0/total)', async () => {
  const { api } = await import('@/api/client')
  api.applyYaml = vi.fn(async () => ({ total: 0 }))   // 无 applied/failed 字段
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="deploy-btn"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="deploy-result"]').exists()).toBe(true)
  expect(w.text()).toContain('0/0')   // (applied||[]).length=0, total=0
})

// T6-m1: 控制器卡片渲染描述(descKey → testid controller-desc 存在)
test('控制器卡片渲染描述(controller-desc testid 存在)', async () => {
  const w = mountDlg()
  await flushPromises()
  expect(w.find('[data-testid="controller-desc"]').exists()).toBe(true)
})

// M1: 控制器卡片渲染 notesKey(testid controller-notes 存在)
test('控制器卡片渲染 notes(controller-notes testid 存在)', async () => {
  const w = mountDlg()
  await flushPromises()
  expect(w.find('[data-testid="controller-notes"]').exists()).toBe(true)
})

// C1: applyYaml 抛错(全失败服务端返回 422)→ failed 块渲染错误,无未处理 rejection
test('apply 失败: applyYaml reject 时 failed 块渲染错误文案(无未处理 rejection)', async () => {
  const { api } = await import('@/api/client')
  api.applyYaml = vi.fn(async () => { throw new Error('boom applyYaml') })
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="deploy-btn"]').trigger('click')
  await flushPromises()
  expect(api.applyYaml).toHaveBeenCalled()
  expect(w.find('[data-testid="deploy-result"]').exists()).toBe(true)
  expect(w.text()).toContain('boom applyYaml')
})

// I1: pick → back-to-select → catalog cards 重新可见
test('返回选择: pick 后点 back-to-select,卡片重新可见', async () => {
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  // editor 步骤:back 按钮存在;卡片此刻不可见(v-if="!pickedId")
  expect(w.find('[data-testid="back-to-select"]').exists()).toBe(true)
  expect(w.find('[data-testid="controller-card"]').exists()).toBe(false)
  await w.find('[data-testid="back-to-select"]').trigger('click')
  // 返回后 pickedId 清空,卡片重新渲染
  expect(w.find('[data-testid="controller-card"]').exists()).toBe(true)
  expect(w.find('[data-testid="back-to-select"]').exists()).toBe(false)
})

// Task 10: 已装检测 —— 集群已有同名 IngressClass 时显示 already-installed 提示
test('已装检测: 集群含 defaultClassName 时显示 already-installed 提示', async () => {
  fetchIngressClassesMock.mockResolvedValueOnce([{ name: 'nginx', isDefault: false }])
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await flushPromises()   // 等 useResourceList 的 fetcher 完成
  expect(w.find('[data-testid="already-installed"]').exists()).toBe(true)
})

// Task 10: 已装检测 —— 集群无同名 IngressClass 时不显示提示
test('已装检测: 集群不含 defaultClassName 时不显示 already-installed 提示', async () => {
  fetchIngressClassesMock.mockResolvedValueOnce([{ name: 'some-other', isDefault: false }])
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await flushPromises()
  expect(w.find('[data-testid="already-installed"]').exists()).toBe(false)
})

