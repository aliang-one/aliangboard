// W3 Task 6:kubectl 访问卡 —— 选集群 → 生成/显示 kubeconfig(readonly textarea)
// + 复制(clipboard)/下载 + 失效说明。409(未连接集群)显示错误态。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const kubeconfigMock = vi.fn()

vi.mock('@/api/client', () => ({
  authApi: {
    myClusters: vi.fn(async () => ({ clusters: [
      { id: 'c1', name: 'prod' },
      { id: 'c2', name: 'dev' },
    ] })),
    myKubeconfig: (...a) => kubeconfigMock(...a),
  },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import KubectlCard from '@/components/userCenter/KubectlCard.vue'
import enLocale from '@/locales/en.json'

const selectCluster = (w, id) => w.find('select').setValue(id)

beforeEach(() => { kubeconfigMock.mockReset() })

test('卡片渲染:集群下拉来自 myClusters,失效说明常显(含不支持操作提示)', async () => {
  setActivePinia(createPinia())
  const w = mount(KubectlCard, { global: { plugins: [i18n] } })
  await flushPromises()
  const options = w.find('select').findAll('option')
  expect(options.map((o) => o.attributes('value'))).toEqual(['', 'c1', 'c2'])
  const hint = w.find('[data-testid="kubectl-expiry-hint"]')
  expect(hint.exists()).toBe(true)
  expect(hint.text()).toContain('exec')
  expect(hint.text()).toContain('port-forward')
  expect(hint.text()).toContain('--server-side')
  // W3 外评修复 4:三项失效条件——登录态 8 小时过期 / 用户被禁用即失效 / 集群分配被收回即失效。
  // 组件按当前 locale 渲染(测试默认 zh);英文文案关键词直查 locale 文件钉住两档。
  expect(hint.text()).toContain('8')
  expect(hint.text()).toContain('禁用')
  expect(hint.text()).toContain('收回')
  const en = enLocale.userCenter.kubectl.expiryHint
  expect(en).toContain('8 hours')
  expect(en).toContain('disabled')
  expect(en).toContain('revoked')
})

test('生成:选中集群 → 调 myKubeconfig(clusterId) → readonly textarea 显示 YAML + 复制按钮', async () => {
  setActivePinia(createPinia())
  kubeconfigMock.mockResolvedValue('apiVersion: v1\nkind: Config\n')
  const w = mount(KubectlCard, { global: { plugins: [i18n] } })
  await flushPromises()
  await selectCluster(w, 'c1')
  await w.find('[data-testid="kubectl-generate"]').trigger('click')
  await flushPromises()
  expect(kubeconfigMock).toHaveBeenCalledTimes(1)
  expect(kubeconfigMock.mock.calls[0][0]).toBe('c1')
  const ta = w.find('textarea')
  expect(ta.exists()).toBe(true)
  expect(ta.attributes('readonly')).toBeDefined()
  expect(ta.element.value).toContain('kind: Config')
})

test('409 未连接集群:错误态展示服务端文案,不渲染 YAML', async () => {
  setActivePinia(createPinia())
  kubeconfigMock.mockRejectedValue(Object.assign(new Error('请先在平台连接该集群'), { status: 409 }))
  const w = mount(KubectlCard, { global: { plugins: [i18n] } })
  await flushPromises()
  await selectCluster(w, 'c2')
  await w.find('[data-testid="kubectl-generate"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="kubectl-error"]').text()).toContain('请先在平台连接该集群')
  expect(w.find('textarea').exists()).toBe(false)
})

test('复制:clipboard.writeText 收到 YAML', async () => {
  setActivePinia(createPinia())
  kubeconfigMock.mockResolvedValue('apiVersion: v1\n')
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const w = mount(KubectlCard, { global: { plugins: [i18n] } })
  await flushPromises()
  await selectCluster(w, 'c1')
  await w.find('[data-testid="kubectl-generate"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="kubectl-copy"]').trigger('click')
  await flushPromises()
  expect(writeText).toHaveBeenCalledWith('apiVersion: v1\n')
})
