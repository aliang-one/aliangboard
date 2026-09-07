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
  // W4 OIDC 配置卡同挂载拉取(安全 tab 第四卡):不桩会走真 fetch(happy-dom 真发请求)
  vi.spyOn(adminApi.oidcConfig, 'get').mockResolvedValue(OIDC_CONFIG)
})

// W4 Task 5:安全 tab 第四卡「SSO 登录(OIDC)」——挂载拉配置回显(hasSecret→占位)、
// 保存 payload 形状(空 secret 省略=保持现值)、测试连接结果渲染。
const OIDC_CONFIG = {
  enabled: false,
  issuer: 'https://idp.example.com',
  clientId: 'aliangboard',
  scopes: 'openid profile email groups',
  groupsClaim: 'groups',
  usernameClaim: 'preferred_username',
  hasSecret: true,
  redirectUri: 'https://board.example.com/api/auth/oidc/callback',
}

async function openSecurityTab(w) {
  const tab = w.findAll('button').find(b => b.text().includes('安全策略'))
  expect(tab).toBeTruthy()
  await tab.trigger('click')
  await flushPromises()
  return w.find('[data-testid="oidc-card"]')
}

test('OIDC 第四卡:挂载拉配置回显,hasSecret → secret 输入占位「已设置」,回调 URI 只读展示', async () => {
  const w = await mountAdminAndAuth()
  await flushPromises()
  expect(adminApi.oidcConfig.get).toHaveBeenCalledTimes(1)
  const card = await openSecurityTab(w)
  expect(card.exists()).toBe(true)
  expect(card.find('input[data-testid="oidc-issuer"]').element.value).toBe('https://idp.example.com')
  expect(card.find('input[data-testid="oidc-client-id"]').element.value).toBe('aliangboard')
  const secret = card.find('input[data-testid="oidc-client-secret"]')
  expect(secret.attributes('type')).toBe('password')
  expect(secret.element.placeholder).toContain(i18n.global.t('admin.oidc.clientSecretSet'))
  expect(secret.element.value).toBe('') // GET 永不回传 secret
  const redirect = card.find('input[data-testid="oidc-redirect-uri"]')
  expect(redirect.attributes('readonly')).toBeDefined()
  expect(redirect.element.value).toBe(OIDC_CONFIG.redirectUri)
})

test('OIDC 保存:payload 含六键且空 secret 省略(留空=保持现值);保存后重拉刷新 hasSecret', async () => {
  vi.spyOn(adminApi.oidcConfig, 'save').mockResolvedValue({ ok: true })
  const w = await mountAdminAndAuth()
  await flushPromises()
  const card = await openSecurityTab(w)
  await card.find('input[data-testid="oidc-scopes"]').setValue('openid profile')
  await card.find('[data-testid="oidc-save"]').trigger('click')
  await flushPromises()
  expect(adminApi.oidcConfig.save).toHaveBeenCalledTimes(1)
  const payload = adminApi.oidcConfig.save.mock.calls[0][0]
  expect(payload).toMatchObject({
    enabled: false,
    issuer: 'https://idp.example.com',
    clientId: 'aliangboard',
    scopes: 'openid profile',
    groupsClaim: 'groups',
    usernameClaim: 'preferred_username',
  })
  expect('clientSecret' in payload).toBe(false) // 空 secret 不发键 = 服务端保持现值
  expect(adminApi.oidcConfig.get).toHaveBeenCalledTimes(2) // 保存后刷新(hasSecret 翻转)
})

test('OIDC 保存:填了 secret 才随 payload 下发', async () => {
  vi.spyOn(adminApi.oidcConfig, 'save').mockResolvedValue({ ok: true })
  const w = await mountAdminAndAuth()
  await flushPromises()
  const card = await openSecurityTab(w)
  await card.find('input[data-testid="oidc-client-secret"]').setValue('new-secret')
  await card.find('[data-testid="oidc-save"]').trigger('click')
  await flushPromises()
  expect(adminApi.oidcConfig.save.mock.calls[0][0].clientSecret).toBe('new-secret')
})

test('OIDC 测试连接:ok → 渲染端点/密钥数/kty;!ok → 错误行', async () => {
  vi.spyOn(adminApi.oidcConfig, 'test').mockResolvedValue({
    ok: true, authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token', jwksKeys: 3, algorithms: ['RSA'],
  })
  const w = await mountAdminAndAuth()
  await flushPromises()
  const card = await openSecurityTab(w)
  await card.find('[data-testid="oidc-test"]').trigger('click')
  await flushPromises()
  expect(adminApi.oidcConfig.test).toHaveBeenCalledTimes(1)
  const result = card.find('[data-testid="oidc-test-result"]')
  expect(result.exists()).toBe(true)
  expect(result.text()).toContain('https://idp.example.com/authorize')
  expect(result.text()).toContain('https://idp.example.com/token')
  expect(result.text()).toContain('3')
  expect(result.text()).toContain('RSA')
  w.unmount()

  vi.spyOn(adminApi.oidcConfig, 'test').mockResolvedValue({ ok: false, error: 'discovery' })
  const w2 = await mountAdminAndAuth()
  await flushPromises()
  const card2 = await openSecurityTab(w2)
  await card2.find('[data-testid="oidc-test"]').trigger('click')
  await flushPromises()
  const result2 = card2.find('[data-testid="oidc-test-result"]')
  expect(result2.text()).toContain(i18n.global.t('admin.oidc.testFailed'))
  w2.unmount()
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
