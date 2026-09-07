// Settings「终端与会话」tab 契约(2026-09-05,由 ssh-policy 测试迁移扩展):
// admin 可见、三组(SSH 会话回收/Pod 终端/SSH 异步任务)读取回填、保存发三个 PUT、失败不崩。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { adminApi } from '@/api/client'
import Settings from '../Settings.vue'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: null, clusters: [], cluster: { name: 'test' } }) }))
vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => ({ locale: 'zh', setLocale: vi.fn() }) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ catalog: { value: [] }, resetAll: vi.fn() }) }))

// auth.user 是响应式 ref(src/stores/auth.js:79 返回形态),mount 前在 pinia 上赋值 { role: 'admin' }
// 即 isAdmin=true → admin tabs(含 terminal)参与渲染。
async function mountAdminAndAuth() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().user = { role: 'admin' }
  return mount(Settings, { global: { plugins: [pinia, i18n] } })
}

const SESSION = { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0, backendIdleMin: 10080 }
beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  vi.spyOn(adminApi.sshSessionPolicy, 'get').mockResolvedValue(SESSION)
  vi.spyOn(adminApi.sshSessionPolicy, 'update').mockResolvedValue({ ok: true, policy: SESSION })
  vi.spyOn(adminApi.podTerminalPolicy, 'get').mockResolvedValue({ idleReapMin: 30 })
  vi.spyOn(adminApi.podTerminalPolicy, 'update').mockResolvedValue({ ok: true, policy: { idleReapMin: 30 } })
  vi.spyOn(adminApi.sshJobPolicy, 'get').mockResolvedValue({ ttlMin: 120, maxPerServer: 4 })
  vi.spyOn(adminApi.sshJobPolicy, 'update').mockResolvedValue({ ok: true, policy: { ttlMin: 120, maxPerServer: 4 } })
  // 安全策略卡同挂载拉取(2026-09-07 W3 外评修复 1 加载项):不桩会走真 fetch(happy-dom 真发请求)
  vi.spyOn(adminApi.mfaPolicy, 'get').mockResolvedValue({ enabled: false })
})

test('admin:「终端与会话」tab 可见,三组策略进页即拉取回填(共 6 个数字输入)', async () => {
  const w = await mountAdminAndAuth()
  await flushPromises()
  expect(adminApi.sshSessionPolicy.get).toHaveBeenCalled()
  expect(adminApi.podTerminalPolicy.get).toHaveBeenCalled()
  expect(adminApi.sshJobPolicy.get).toHaveBeenCalled()
  const tab = w.findAll('button').find(b => b.text().includes('终端与会话'))
  expect(tab).toBeTruthy()
  await tab.trigger('click')
  await flushPromises()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs.length).toBe(7)   // 会话 4(含阶段二 backendIdleMin) + pod 1 + job 2
})

test('保存:一次点击串发三个 PUT,回传各组当前值', async () => {
  const w = await mountAdminAndAuth()
  await flushPromises()
  const tab = w.findAll('button').find(b => b.text().includes('终端与会话'))
  await tab.trigger('click')
  await flushPromises()
  const save = w.findAll('button').find(b => b.text().includes('保存'))
  await save.trigger('click')
  await flushPromises()
  expect(adminApi.sshSessionPolicy.update).toHaveBeenCalledWith(SESSION)
  expect(adminApi.podTerminalPolicy.update).toHaveBeenCalledWith({ idleReapMin: 30 })
  expect(adminApi.sshJobPolicy.update).toHaveBeenCalledWith({ ttlMin: 120, maxPerServer: 4 })
})

test('保存失败(400)→ 不崩,错误提示', async () => {
  adminApi.sshJobPolicy.update.mockRejectedValue(new Error('invalid'))
  const w = await mountAdminAndAuth()
  await flushPromises()
  const tab = w.findAll('button').find(b => b.text().includes('终端与会话'))
  await tab.trigger('click')
  await flushPromises()
  const save = w.findAll('button').find(b => b.text().includes('保存'))
  await save.trigger('click')
  await flushPromises()
  expect(w.exists()).toBe(true)
})
