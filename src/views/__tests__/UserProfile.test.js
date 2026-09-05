// 三卡交互:资料就地编辑 / 改密表单校验+提交 / 会话列表渲染+吊销确认 / 偏好联动 store。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const routeState = vi.hoisted(() => ({ query: {} }))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => routeState,
}))
const apiMocks = vi.hoisted(() => ({
  updateMe: vi.fn(),
  changePassword: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  savePreferences: vi.fn().mockResolvedValue({}),
  myActivity: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 50, windowDays: 90 }),
  myKeysList: vi.fn().mockResolvedValue({ apikeys: [] }),
  myKeysMint: vi.fn(), myKeysRevoke: vi.fn(),
  myClusters: vi.fn().mockResolvedValue({ clusters: [] }),
  getPasswordPolicy: vi.fn().mockResolvedValue({ policy: { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false } }),
  getAvatar: vi.fn().mockRejectedValue({ status: 404 }),
  uploadAvatar: vi.fn(), clearAvatar: vi.fn(),
}))
vi.mock('@/api/client', () => ({ authApi: apiMocks }))

import UserProfile from '@/views/UserProfile.vue'
import Pagination from '@/components/common/Pagination.vue'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.savePreferences.mockResolvedValue({})
  const auth = useAuthStore()
  auth.user = { id: 'u1', username: 'alice', role: 'user', displayName: 'Alice', createdAt: 1756400000000 }
  apiMocks.listSessions.mockResolvedValue({ sessions: [
    { fingerprint: 'abcd1234', ip: '1.2.3.4', userAgent: 'Mozilla/5.0 Chrome Safari', createdAt: 1756400000000, lastSeenAt: 1756400100000, current: true },
    { fingerprint: 'beef5678', ip: '5.6.7.8', userAgent: 'Mozilla/5.0 Firefox', createdAt: 1756300000000, lastSeenAt: 1756390000000, current: false },
  ] })
  apiMocks.updateMe.mockResolvedValue({ user: { id: 'u1', username: 'alice', role: 'user', displayName: '阿亮' } })
})

function mountPage(tab = 'security') {
  routeState.query = { tab }
  return mount(UserProfile, { global: { plugins: [i18n] } })
}

test('挂载:拉会话列表,渲染两行,当前行有标记', async () => {
  const w = mountPage()
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(1)
  const rows = w.findAll('[data-testid="session-row"]')
  expect(rows).toHaveLength(2)
  expect(rows[0].text()).toContain('1.2.3.4')
  expect(w.text()).toContain('Chrome')
  w.unmount()
})

test('displayName 就地编辑:保存调 updateMe 并回写 authStore', async () => {
  const w = mountPage('profile')
  await flushPromises()
  await w.find('[data-testid="profile-displayname-input"]').setValue('阿亮')
  await w.find('[data-testid="profile-displayname-save"]').trigger('click')
  await flushPromises()
  expect(apiMocks.updateMe).toHaveBeenCalledWith({ displayName: '阿亮' })
  expect(useAuthStore().user.displayName).toBe('阿亮')
  w.unmount()
})

test('改密:两次新密不一致 → 客户端拒绝不发请求', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-confirm"]').setValue('newpassword2')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()
  w.unmount()
})

test('改密:新密 <8 → 客户端拒绝;通过则调 API + 成功清表单', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('short')
  await w.find('[data-testid="pwd-confirm"]').setValue('short')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()

  apiMocks.changePassword.mockResolvedValueOnce({ ok: true, revoked: 1 })
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-confirm"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  await flushPromises()
  expect(apiMocks.changePassword).toHaveBeenCalledWith('right-password', 'newpassword1')
  expect(w.find('[data-testid="pwd-new"]').element.value).toBe('')
  w.unmount()
})

test('吊销单会话:走 ConfirmDialog,确认后调 revokeSession 并刷新列表', async () => {
  const w = mountPage()
  await flushPromises()
  apiMocks.revokeSession.mockResolvedValueOnce({ ok: true })
  await w.find('[data-testid="session-revoke-beef5678"]').trigger('click')
  expect(apiMocks.revokeSession).not.toHaveBeenCalled()
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await flushPromises()
  expect(apiMocks.revokeSession).toHaveBeenCalledWith('beef5678')
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('当前会话行不渲染吊销按钮(防自锁)', async () => {
  const w = mountPage()
  await flushPromises()
  expect(w.find('[data-testid="session-revoke-abcd1234"]').exists()).toBe(false)
  expect(w.find('[data-testid="sessions-revoke-others"]').exists()).toBe(true)
  w.unmount()
})

// === 会话列表分页(2026-08-30 设计 §4) ===
function makeSessions(n) {
  return Array.from({ length: n }, (_, i) => ({
    fingerprint: `fp${String(i).padStart(2, '0')}`, ip: `10.0.0.${i}`, userAgent: 'Mozilla/5.0 Chrome',
    createdAt: 1756400000000, lastSeenAt: 1756400000000 + i, current: false,
  }))
}

test('会话分页:>10 条出现分页条,首屏切前 10 条,翻页看剩余', async () => {
  apiMocks.listSessions.mockResolvedValue({ sessions: makeSessions(12) })
  const w = mountPage()
  await flushPromises()
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(10)
  const pag = w.find('[data-testid="sessions-pagination"]')
  expect(pag.exists()).toBe(true)
  await pag.findAll('button')[1].trigger('click')   // 下一页(Pagination 只有 prev/next 两按钮)
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(2)
  expect(w.findAll('[data-testid="session-row"]')[0].text()).toContain('10.0.0.10')
  w.unmount()
})

test('会话分页:≤10 条不显示分页条', async () => {
  const w = mountPage()
  await flushPromises()
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(2)
  expect(w.find('[data-testid="sessions-pagination"]').exists()).toBe(false)
  w.unmount()
})

test('会话分页:末页吊销后页码收敛(clamp),不悬空', async () => {
  apiMocks.listSessions.mockResolvedValue({ sessions: makeSessions(11) })
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="sessions-pagination"]').findAll('button')[1].trigger('click')
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(1)
  apiMocks.revokeSession.mockResolvedValueOnce({ ok: true })
  apiMocks.listSessions.mockResolvedValue({ sessions: makeSessions(10) })   // 重拉后只剩 10 条
  await w.find('[data-testid="session-revoke-fp10"]').trigger('click')
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(10)
  // 页码收敛回第 1 页:首行是 fp00
  expect(w.findAll('[data-testid="session-row"]')[0].text()).toContain('10.0.0.0')
  w.unmount()
})

test('安全卡:会话行显示登录时间 createdAt;刷新钮重拉列表', async () => {
  const w = mountPage('security')
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(1)
  expect(w.find('[data-testid="session-row"]').text()).toContain(new Date(1756400000000).toLocaleDateString())
  await w.find('[data-testid="sessions-refresh"]').trigger('click')
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('改密:策略档(服务端 policy)缺数字 → 客户端拒绝不发请求', async () => {
  apiMocks.getPasswordPolicy.mockResolvedValue({ policy: { minLength: 8, requireMixed: false, requireDigit: true, requireSymbol: false } })
  const w = mountPage('security')
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('NoDigitsHere')
  await w.find('[data-testid="pwd-confirm"]').setValue('NoDigitsHere')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()
  w.unmount()
})

test('偏好卡:语言/主题选择联动 preferences store', async () => {
  const w = mountPage('preferences')
  await flushPromises()
  await w.find('[data-testid="pref-lang-en"]').trigger('click')
  await w.find('[data-testid="pref-theme-dark"]').trigger('click')
  const prefs = usePreferencesStore()
  expect(prefs.language).toBe('en')
  expect(prefs.theme).toBe('dark')
  w.unmount()
})

test('活动 tab:挂载拉取并渲染行;result 过滤变化重拉;空态;90 天窗口提示', async () => {
  apiMocks.myActivity.mockResolvedValue({ items: [
    { seq: 3, ts: 1756400100000, tool: 'platform_login', verb: 'login', result: 'ok', owner: 'alice', clusterId: null, namespace: null, resource: null, requestSummary: 'ip=1.2.3.4' },
    { seq: 2, ts: 1756300000000, tool: 'my_key_mint', verb: 'write', result: 'ok', owner: 'alice', clusterId: 'c1', namespace: 'team-a', resource: null, requestSummary: 'id=x tier=read' },
  ], total: 2, page: 1, size: 50, windowDays: 90 })
  const w = mountPage('activity')
  await flushPromises()
  expect(apiMocks.myActivity).toHaveBeenCalledWith({})
  const rows = w.findAll('[data-testid="activity-row"]')
  expect(rows).toHaveLength(2)
  expect(w.text()).toContain('platform_login')
  expect(w.find('[data-testid="activity-window"]').text()).toContain('90')
  await w.find('[data-testid="activity-result-filter"]').setValue('denied')
  await flushPromises()
  expect(apiMocks.myActivity).toHaveBeenLastCalledWith({ result: 'denied' })
  w.unmount()
})

test('活动 tab:空列表渲染空态', async () => {
  apiMocks.myActivity.mockResolvedValue({ items: [], total: 0, page: 1, size: 50, windowDays: 90 })
  const w = mountPage('activity')
  await flushPromises()
  expect(w.find('[data-testid="activity-empty"]').exists()).toBe(true)
  w.unmount()
})

// === Task 11: 访问令牌 tab ===
test('令牌 tab:挂载拉 key 列表 + 集群列表,渲染行(含过期/吊销态)', async () => {
  apiMocks.myKeysList.mockResolvedValue({ apikeys: [
    { id: 'k1', prefix: 'abcd1234', label: 'ci', clusterId: 'c1', boundSA_namespace: 'team-a', tier: 'read', createdAt: 1756400000000, expiresAt: Date.now() + 86400000, lastUsedAt: null, revokedAt: null, ownerUserId: 'u1' },
    { id: 'k2', prefix: 'beef5678', label: 'old', clusterId: 'c1', boundSA_namespace: 'team-a', tier: 'read', createdAt: 1756300000000, expiresAt: Date.now() - 86400000, lastUsedAt: 1756390000000, revokedAt: null, ownerUserId: 'u1' },
    { id: 'k3', prefix: 'dead0000', label: 'x', clusterId: 'c1', boundSA_namespace: 'team-a', tier: 'read', createdAt: 1756200000000, expiresAt: null, lastUsedAt: null, revokedAt: 1756250000000, ownerUserId: 'u1' },
  ] })
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  const w = mountPage('tokens')
  await flushPromises()
  expect(apiMocks.myKeysList).toHaveBeenCalledTimes(1)
  const rows = w.findAll('[data-testid="token-row"]')
  expect(rows).toHaveLength(3)
  expect(rows[0].text()).toContain('abcd1234')
  expect(rows[1].html()).toContain('expired')              // data-testid=token-status-expired
  expect(rows[2].html()).toContain('revoked')
  expect(w.find('[data-testid="token-revoke-k3"]').exists()).toBe(false)
  w.unmount()
})

test('签发:填表 mint → 明文只显一次弹窗(含复制钮)→ 关闭后列表重拉', async () => {
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  apiMocks.myKeysList.mockResolvedValue({ apikeys: [] })
  apiMocks.myKeysMint.mockResolvedValue({ apikey: { id: 'k9', plaintext: 'PLAINTEXT-VALUE-123', prefix: 'PLAINTEXT' } })
  const w = mountPage('tokens')
  await flushPromises()
  await w.find('[data-testid="token-mint-btn"]').trigger('click')
  // 签发/明文 Modal 均 Teleport 到 body(既有契约),teleported 节点走 document.body 查询
  const bq = (sel) => document.body.querySelector(sel)
  bq('[data-testid="token-mint-cluster"]').value = 'c1'
  bq('[data-testid="token-mint-cluster"]').dispatchEvent(new Event('change'))
  bq('[data-testid="token-mint-namespace"]').value = 'team-a'
  bq('[data-testid="token-mint-namespace"]').dispatchEvent(new Event('input'))
  await nextTick()
  bq('[data-testid="token-mint-submit"]').click()
  await flushPromises()
  expect(apiMocks.myKeysMint).toHaveBeenCalledWith({ clusterId: 'c1', namespace: 'team-a', tier: 'read', label: '', ttlDays: 30 })
  expect(bq('[data-testid="token-plaintext"]').textContent).toContain('PLAINTEXT-VALUE-123')
  expect(bq('[data-testid="token-copy"]')).toBeTruthy()
  bq('[data-testid="token-plaintext-close"]').click()
  await nextTick()
  expect(apiMocks.myKeysList).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('吊销:确认框链后调 myKeysRevoke 并重拉', async () => {
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  apiMocks.myKeysList.mockResolvedValue({ apikeys: [{ id: 'k1', prefix: 'abcd1234', label: '', clusterId: 'c1', boundSA_namespace: 'n', tier: 'read', createdAt: 1, expiresAt: null, lastUsedAt: null, revokedAt: null }] })
  apiMocks.myKeysRevoke.mockResolvedValue({ ok: true })
  const w = mountPage('tokens')
  await flushPromises()
  await w.find('[data-testid="token-revoke-k1"]').trigger('click')
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await flushPromises()
  expect(apiMocks.myKeysRevoke).toHaveBeenCalledWith('k1')
  expect(apiMocks.myKeysList).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('活动 tab:翻页重拉携带 page+size', async () => {
  apiMocks.myActivity.mockResolvedValue({ items: [
    { seq: 60, ts: 1756400100000, tool: 'platform_login', verb: 'login', result: 'ok', owner: 'alice', clusterId: null, namespace: null, resource: null, requestSummary: 'ip=1.2.3.4' },
  ], total: 60, page: 1, size: 50, windowDays: 90 })
  const w = mountPage('activity')
  await flushPromises()
  expect(w.findComponent(Pagination).exists()).toBe(true)
  w.findComponent(Pagination).vm.$emit('page-change', 2)
  await flushPromises()
  expect(apiMocks.myActivity).toHaveBeenLastCalledWith({ page: 2, size: 50 })
  w.unmount()
})
