// Settings「安全策略」tab 第三卡「强制两步验证」(W3 §1.5 外评修复 1):
// 服务端 GET/PUT /api/admin/mfa-policy 已存在但 src/ 零调用——开了关不掉。本卡补 UI 面:
// admin 挂载拉取回显、切换调 save、说明文案含「强制下线存量会话」配套建议(外评 minor #7)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { adminApi } from '@/api/client'
import Settings from '../Settings.vue'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: null, clusters: [], cluster: { name: 'test' } }) }))
vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => ({ locale: 'zh', setLocale: vi.fn() }) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ catalog: { value: [] }, resetAll: vi.fn() }) }))

// 与 Settings.terminal-policy.test.js 同款挂载:auth.user 是响应式 ref,mount 前在 pinia 上赋值
// { role: 'admin' } → security tab 参与渲染。
async function mountAdminAndAuth() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().user = { role: 'admin' }
  return mount(Settings, { global: { plugins: [pinia, i18n] } })
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  // Settings 挂载(admin)会串拉全部策略端点;未打桩的会走真 fetch(happy-dom 真发请求),
  // 串行 await 拖住 loadSecurityPolicy 后段的 mfaPolicy.get——全量打桩,网络零触达。
  vi.spyOn(adminApi.mfaPolicy, 'get').mockResolvedValue({ enabled: false })
  vi.spyOn(adminApi.mfaPolicy, 'save').mockResolvedValue({ enabled: true })
  vi.spyOn(adminApi.passwordPolicy, 'get').mockResolvedValue({ policy: {} })
  vi.spyOn(adminApi.tokenPolicy, 'get').mockResolvedValue({ maxTtlDays: 90 })
  vi.spyOn(adminApi.mcpConfig, 'get').mockResolvedValue({ enabled: true })
  vi.spyOn(adminApi.podfileConfig, 'get').mockResolvedValue({ limitMb: 1024 })
  vi.spyOn(adminApi.sshSessionPolicy, 'get').mockResolvedValue({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0, backendIdleMin: 10080 })
  vi.spyOn(adminApi.podTerminalPolicy, 'get').mockResolvedValue({ idleReapMin: 30 })
  vi.spyOn(adminApi.sshJobPolicy, 'get').mockResolvedValue({ ttlMin: 120, maxPerServer: 4 })
})

test('admin:安全策略 tab 渲染第三卡——挂载即拉取策略;文案含引导说明与强制下线建议', async () => {
  const w = await mountAdminAndAuth()
  await flushPromises()
  expect(adminApi.mfaPolicy.get).toHaveBeenCalledTimes(1)
  const tab = w.findAll('button').find(b => b.text().includes('安全策略'))
  expect(tab).toBeTruthy()
  await tab.trigger('click')
  await flushPromises()
  const card = w.find('[data-testid="mfa-policy-card"]')
  expect(card.exists()).toBe(true)
  expect(card.text()).toContain('强制两步验证')
  // 说明:开后未启用用户登录只见 MFA 引导 + 建议配套强制下线存量会话(外评 minor #7)
  expect(card.text()).toContain('强制下线')
})

test('切换:点击开关 → save({enabled:true}) → 以回传态回显', async () => {
  const w = await mountAdminAndAuth()
  await flushPromises()
  const tab = w.findAll('button').find(b => b.text().includes('安全策略'))
  await tab.trigger('click')
  await flushPromises()
  await w.find('[data-testid="mfa-policy-toggle"]').trigger('click')
  await flushPromises()
  expect(adminApi.mfaPolicy.save).toHaveBeenCalledWith({ enabled: true })
})

test('非 admin 看不到安全策略 tab(卡片随 tab 不渲染)', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().user = { role: 'user' }
  const w = mount(Settings, { global: { plugins: [pinia, i18n] } })
  await flushPromises()
  expect(w.findAll('button').some(b => b.text().includes('安全策略'))).toBe(false)
  expect(w.find('[data-testid="mfa-policy-card"]').exists()).toBe(false)
  w.unmount()
})
