// 无集群项目(2026-08-30 Task 5)页面契约:
// ① 未绑定项目(clusterId='')卡片显示「未绑定集群」徽章而非 '-';
// ② 卡片绑定下拉列出全部集群,change → workbenchApi.updateProjectCluster(id, value);
// ③ 建项目确认按钮不再因未选集群禁用(集群可选)。
// 集群数据源沿用组件现状:authApi.myClusters(workbenchApi 无 listClusters,不重复设端点)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  updateProjectCluster: vi.fn(),
  myClusters: vi.fn(),
}))
vi.mock('@/api/client', () => ({
  workbenchApi: {
    listProjects: mocks.listProjects,
    createProject: vi.fn(),
    updateProjectCluster: mocks.updateProjectCluster,
  },
  authApi: { myClusters: mocks.myClusters },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('@/composables/useToast.js', () => ({ notify: vi.fn() }))

import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const messages = { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) }
const i18n = createI18n({ legacy: false, locale: 'zh', messages })

async function mountProjects() {
  const w = mount(WorkbenchProjects, { global: { plugins: [createPinia(), i18n] } })
  await flushPromises()
  return w
}

let mounted = null
beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

test('未绑定项目:徽章可见 + 换绑下拉列出集群并可提交', async () => {
  mocks.listProjects.mockResolvedValue({ projects: [{ id: 'p1', name: 'P1', clusterId: '', repoRoot: 'projects', ownerId: 'u' }] })
  mocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'CK' }] })
  mocks.updateProjectCluster.mockResolvedValue({ ok: true, project: { clusterId: 'c1', clusterName: 'CK' } })
  const w = await mountProjects()
  mounted = w
  expect(w.find('[data-test="unbound-badge"]').exists()).toBe(true)
  expect(w.find('[data-test="unbound-badge"]').text()).toBe('未绑定集群')
  const bind = w.find('[data-test="bind-cluster"]')
  expect(bind.exists()).toBe(true)
  const opts = bind.findAll('option').map(o => o.element.value)
  expect(opts).toContain('c1')
  await bind.setValue('c1')
  expect(mocks.updateProjectCluster).toHaveBeenCalledWith('p1', 'c1')
})

test('已绑定项目:显示集群名,无徽章', async () => {
  mocks.listProjects.mockResolvedValue({ projects: [{ id: 'p1', name: 'P1', clusterId: 'c1' }] })
  mocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'CK' }] })
  const w = await mountProjects()
  mounted = w
  expect(w.find('[data-test="unbound-badge"]').exists()).toBe(false)
  expect(w.text()).toContain('CK')
})

test('建项目:未选集群时确认按钮可点(集群可选)', async () => {
  mocks.listProjects.mockResolvedValue({ projects: [] })
  mocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'CK' }] })
  const w = await mountProjects()
  mounted = w
  await w.findAll('button').find(b => b.text().includes('新建项目')).trigger('click')
  await flushPromises()
  const modal = document.body.querySelector('.animate-slide-up')
  expect(modal, '创建 Modal 渲染到 body').toBeTruthy()
  const nameInput = modal.querySelector('input')
  nameInput.value = 'p-no-cluster'
  nameInput.dispatchEvent(new Event('input'))
  await flushPromises()
  const confirm = [...modal.querySelectorAll('button')].pop()
  expect(confirm.disabled, '未选集群不再禁用确认').toBe(false)
})
