import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

// 组件 setup 同步调用 useRouter()(vue-router);watch(modelValue) 异步读
// store.remoteMode/workloadList/namespaceList。直接 mock store(避开 cluster.js
// 完整 setup 链:localStorage/getSavedClusters/多 api 导出),与仓库既有 NsIngress 测试
// mock @/stores/cluster 同理(隔离网络/storage 副作用)。vi.mock 工厂被提升到文件顶部,
// 引用外部变量须用 vi.hoisted 声明(否则 ReferenceError);工厂内不引 vue 的 ref(同样
// 存在 TDZ),改用普通值(组件 computed 走 `store.x || []`,非 `.value`)。
const push = vi.hoisted(() => vi.fn())
const storeState = vi.hoisted(() => ({
  remoteMode: false,
  workloadList: [],
  namespaceList: [{ name: 'default' }, { name: 'prod' }],
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => storeState }))

import CopyWorkloadDialog from '@/components/common/CopyWorkloadDialog.vue'

test('CopyWorkloadDialog: SFC compiles (dynamic import resolves)', async () => {
  const mod = await import('@/components/common/CopyWorkloadDialog.vue')
  expect(mod.default).toBeTruthy()
})

test('CopyWorkloadDialog: 挂载渲染标题 + 命名空间下拉 + 空状态文案', async () => {
  // mock:remoteMode=false → 走 mock 分支,workloadList 为空 → empty 文案。
  const wrapper = mount(CopyWorkloadDialog, {
    props: { modelValue: true },
    global: { plugins: [createPinia(), i18n] },
  })
  // Modal teleport 到 body;查 document.body。
  expect(document.body.textContent).toContain(i18n.global.t('component.copyWorkload.title'))
  expect(document.body.textContent).toContain(i18n.global.t('component.copyWorkload.empty'))
  // 命名空间下拉含 namespaceList 投影
  expect(document.body.textContent).toContain('default')
  wrapper.unmount()
})
