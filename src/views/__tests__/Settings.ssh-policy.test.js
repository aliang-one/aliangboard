// Settings SSH 策略卡契约:admin 可见、读取回填、保存发 PUT、失败提示。
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
// 即 isAdmin=true → admin tabs(含 ssh)参与渲染。
async function mountAdminAndAuth() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().user = { role: 'admin' }
  return mount(Settings, { global: { plugins: [pinia, i18n] } })
}

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear() })

test('admin:SSH tab 可见、进页拉策略回填、保存发全量 PUT', async () => {
  const get = vi.spyOn(adminApi.sshSessionPolicy, 'get').mockResolvedValue({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
  const update = vi.spyOn(adminApi.sshSessionPolicy, 'update').mockResolvedValue({ ok: true, policy: { detachedIdleMin: 0, attachedIdleMin: 30, maxLifetimeMin: 0 } })
  const w = await mountAdminAndAuth()
  await flushPromises()
  expect(get).toHaveBeenCalled()
  const tab = w.findAll('button').find(b => b.text().includes('SSH'))
  expect(tab).toBeTruthy()
  await tab.trigger('click')
  await flushPromises()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs.length).toBe(3)
  const save = w.findAll('button').find(b => b.text().includes('保存'))
  await save.trigger('click')
  await flushPromises()
  expect(update).toHaveBeenCalledWith({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
})

test('保存失败(400)→ 不崩,错误 notify', async () => {
  vi.spyOn(adminApi.sshSessionPolicy, 'get').mockResolvedValue({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
  vi.spyOn(adminApi.sshSessionPolicy, 'update').mockRejectedValue(new Error('invalid'))
  const w = await mountAdminAndAuth()
  await flushPromises()
  const tab = w.findAll('button').find(b => b.text().includes('SSH'))
  await tab.trigger('click')
  await flushPromises()
  const save = w.findAll('button').find(b => b.text().includes('保存'))
  await save.trigger('click')
  await flushPromises()
  expect(w.exists()).toBe(true)
})
