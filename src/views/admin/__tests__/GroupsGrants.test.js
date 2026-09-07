// W2 Phase A Task 5: admin 组与 ns 授权管理页。
// 覆盖:挂载拉 groups/clusters;新建组 POST;展开成员(读回);添加成员 POST(用户名匹配 users.list);
// ns 授权编辑器(DNS 校验拒绝非法 ns)+ 保存 PUT 全量替换 payload 形状;open 集群提示条渲染。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const groupsList = vi.fn(async () => ({ groups: [{ id: 'g1', name: 'devs', memberCount: 1, grants: 1 }] }))
const groupsCreate = vi.fn(async () => ({ group: { id: 'g2' } }))
const groupsMembersList = vi.fn(async () => ({ members: [{ userId: 'u1', username: 'alice', displayName: null }] }))
const groupsMembers = vi.fn(async () => ({ ok: true }))
const clustersList = vi.fn(async () => ({ clusters: [
  { id: 'c1', name: 'allow-one', nsAuthMode: 'allowlist' },
  { id: 'c2', name: 'open-one', nsAuthMode: 'open' },
] }))
const grantsList = vi.fn(async () => ({ namespaces: [{ namespace: 'app', level: 'view' }] }))
const grantsSave = vi.fn(async () => ({ ok: true }))
const usersList = vi.fn(async () => ({ users: [{ id: 'u1', username: 'alice', role: 'user', clusterIds: [] }] }))
// 残余收尾 fix 1:nsAuthMode 切换(adminApi.nsMode.set 已存在 client.js,零新增 client 代码)
const nsModeSet = vi.fn(async () => ({ ok: true, mode: 'allowlist' }))

vi.mock('@/api/client', () => ({
  adminApi: {
    groups: {
      list: (...a) => groupsList(...a),
      create: (...a) => groupsCreate(...a),
      remove: vi.fn(),
      members: (...a) => groupsMembers(...a),
      membersList: (...a) => groupsMembersList(...a),
      removeMember: vi.fn(),
    },
    clusters: { list: (...a) => clustersList(...a) },
    nsMode: { set: (...a) => nsModeSet(...a) },
    grants: { save: (...a) => grantsSave(...a), list: (...a) => grantsList(...a) },
    users: { list: (...a) => usersList(...a) },
  },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import GroupsGrants from '../GroupsGrants.vue'

function mountView() {
  return mount(GroupsGrants, { global: { plugins: [i18n] } })
}

beforeEach(() => {
  for (const m of [groupsList, groupsCreate, groupsMembersList, groupsMembers, clustersList, grantsList, grantsSave, usersList, nsModeSet]) m.mockClear()
})

// 终审 Finding 1:nsAuthMode 必须来自 API 白名单回传——响应缺该字段时不得误报 open 提示
test('clusters 响应无 nsAuthMode 字段(生产白名单遗漏形态)→ 无 open 提示条', async () => {
  setActivePinia(createPinia())
  clustersList.mockImplementationOnce(async () => ({ clusters: [
    { id: 'c1', name: 'allow-one' },
    { id: 'c2', name: 'open-one' },
  ] }))
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="open-mode-notice"]').exists()).toBe(false)
  // 下拉选项也不得标 (open)
  expect(w.text()).not.toContain('(open)')
})

test('挂载:拉 groups + clusters;open 集群提示条渲染', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  expect(groupsList).toHaveBeenCalledTimes(1)
  expect(clustersList).toHaveBeenCalledTimes(1)
  expect(w.text()).toContain('devs')
  // open 模式风险提示(存在任一 open 集群即显示)
  expect(w.find('[data-testid="open-mode-notice"]').exists()).toBe(true)
  expect(w.find('[data-testid="open-mode-notice"]').text()).toContain('open-one')
})

test('新建组:输入名称 → POST /admin/groups', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  const nameInput = w.find('[data-testid="new-group-input"]')
  await nameInput.setValue('qa-team')
  await w.find('[data-testid="new-group-btn"]').trigger('click')
  await flushPromises()
  expect(groupsCreate).toHaveBeenCalledWith('qa-team')
})

test('成员:展开组读回成员清单;按用户名添加 → POST members(userIds 匹配 id)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="group-row-g1"]').trigger('click')
  await flushPromises()
  expect(groupsMembersList).toHaveBeenCalledWith('g1')
  expect(w.text()).toContain('alice')
  await w.find('[data-testid="member-add-input"]').setValue('alice')
  await w.find('[data-testid="member-add-btn"]').trigger('click')
  await flushPromises()
  expect(usersList).toHaveBeenCalled()
  expect(groupsMembers).toHaveBeenCalledWith('g1', ['u1'])
})

test('ns 授权:选组+集群回显 grants;非法 ns 拒入;合法 ns 保存 → PUT 全量替换 payload', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="grant-group-g1"]').trigger('click')
  await w.find('[data-testid="cluster-select"]').setValue('c1')
  await flushPromises()
  expect(grantsList).toHaveBeenCalledWith({ subjectType: 'group', subjectId: 'g1', clusterId: 'c1' })
  expect(w.text()).toContain('app')

  const nsInput = w.find('[data-testid="ns-add-input"]')
  await nsInput.setValue('Bad_Ns')
  await w.find('[data-testid="ns-add-btn"]').trigger('click')
  expect(w.findAll('[data-testid^="ns-row-"]').length).toBe(1) // 未新增

  await nsInput.setValue('ops')
  await w.find('[data-testid="ns-add-btn"]').trigger('click')
  expect(w.findAll('[data-testid^="ns-row-"]').length).toBe(2)

  await w.find('[data-testid="grant-save-btn"]').trigger('click')
  await flushPromises()
  expect(grantsSave).toHaveBeenCalledTimes(1)
  const payload = grantsSave.mock.calls[0][0]
  expect(payload).toMatchObject({ subjectType: 'group', subjectId: 'g1', clusterId: 'c1' })
  const nss = payload.namespaces.map(r => `${r.namespace}:${r.level}`).sort()
  expect(nss).toEqual(['app:view', 'ops:view'])
})

// ===== 残余收尾 fix 1:nsAuthMode 切换控件(spec 承诺级) =====
// ConfirmDialog 经 Modal Teleport 到 body(既有契约),弹窗节点走 document.body 查询。
test('ns 模式切换:open→allowlist 走确认弹窗(警示文案);确认 → PUT nsMode.set + 重拉 clusters,警告条消失', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="open-mode-notice"]').exists()).toBe(true)
  await w.find('[data-testid="grant-group-g1"]').trigger('click')
  await w.find('[data-testid="cluster-select"]').setValue('c2')
  await flushPromises()
  // 选中 open 集群:编辑器内逐集群警示可见;当前模式钮(open)高亮
  expect(w.text()).toContain(i18n.global.t('admin.authz.openNoIsolation', { names: 'open-one' }))
  expect(w.find('[data-testid="ns-mode-open"]').classes()).toContain('bg-primary')
  // 点 allowlist → 确认弹窗(切到 allowlist 警示),未确认前不发请求
  await w.find('[data-testid="ns-mode-allowlist"]').trigger('click')
  await flushPromises()
  const ok = document.body.querySelector('[data-testid="confirm-ok"]')
  expect(ok).toBeTruthy()
  expect(document.body.textContent).toContain(i18n.global.t('admin.authz.nsModeToAllowlist'))
  expect(nsModeSet).not.toHaveBeenCalled()
  // 确认 → PUT payload (clusterId, mode) + 重拉 clusters(c2 已切 allowlist)→ 两条警示消失
  clustersList.mockImplementation(async () => ({ clusters: [
    { id: 'c1', name: 'allow-one', nsAuthMode: 'allowlist' },
    { id: 'c2', name: 'open-one', nsAuthMode: 'allowlist' },
  ] }))
  ok.click()
  await flushPromises()
  expect(nsModeSet).toHaveBeenCalledTimes(1)
  expect(nsModeSet).toHaveBeenCalledWith('c2', 'allowlist')
  expect(clustersList).toHaveBeenCalledTimes(2)
  expect(w.find('[data-testid="open-mode-notice"]').exists()).toBe(false)
  expect(w.text()).not.toContain(i18n.global.t('admin.authz.openNoIsolation', { names: 'open-one' }))
  expect(w.find('[data-testid="ns-mode-allowlist"]').classes()).toContain('bg-primary')
  w.unmount()
})

test('ns 模式切换:allowlist→open 提示恢复全开;取消不发请求', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="grant-group-g1"]').trigger('click')
  await w.find('[data-testid="cluster-select"]').setValue('c1')
  await flushPromises()
  expect(w.find('[data-testid="ns-mode-allowlist"]').classes()).toContain('bg-primary')
  await w.find('[data-testid="ns-mode-open"]').trigger('click')
  await flushPromises()
  expect(document.body.textContent).toContain(i18n.global.t('admin.authz.nsModeToOpen'))
  document.body.querySelector('[data-testid="confirm-cancel"]').click()
  await flushPromises()
  expect(nsModeSet).not.toHaveBeenCalled()
  // 弹窗已关:确认钮从 body 消失
  expect(document.body.querySelector('[data-testid="confirm-ok"]')).toBe(null)
  w.unmount()
})
