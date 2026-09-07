// 分层 401 语义回归(首装 bug:admin 进集群管理页被 401 死循环弹回选集群页)。
//
// 背景:两层鉴权——平台层(x-platform-token)与 K8s 会话层(authorization: Bearer)。
// K8s 层 401 ≠ 平台未登录:首装未连接集群时 k8s 请求天然 401,曾误走
// clearSession + 跳 /login → 守卫见平台 token 有效又弹回 /select-cluster → 死循环。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, authApi, getSessionToken, saveSession, savePlatformToken } from '@/api/client'

function res401(msg = '未登录或平台会话已过期') {
  const text = JSON.stringify({ message: msg })
  return { ok: false, status: 401, text: async () => text }
}

describe('K8s 会话层 401 分层语义', () => {
  let fetchMock
  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock
    localStorage.clear(); sessionStorage.clear()
    window.location.href = 'http://localhost/admin/clusters'
  })
  afterEach(() => { delete global.fetch })

  it('无 k8s session 收到 401 = 未连接集群(预期状态):不清平台凭据、不跳转', async () => {
    savePlatformToken('plat-token')
    fetchMock.mockResolvedValue(res401())
    // 首装场景:admin 在 /admin/clusters(requiresCluster:false),AppLayout/TopNavBar 发 k8s 请求
    await expect(api.k8s('/api/v1/namespaces')).rejects.toMatchObject({ status: 401 })
    expect(getSessionToken()).toBe('')                                    // 本来就没有,也不产生脏状态
    expect(localStorage.getItem('aliangboard.platform')).toBe('plat-token') // 平台登录不受牵连
    expect(window.location.pathname).toBe('/admin/clusters')              // 留在当前页,不弹
  })

  it('有 k8s session 收到 401 = 会话过期:清 session,跳集群选择页而非 /login', async () => {
    savePlatformToken('plat-token')
    saveSession('stale-k8s-token', true)
    fetchMock.mockResolvedValue(res401())
    await expect(api.k8s('/api/v1/namespaces')).rejects.toMatchObject({ status: 401 })
    expect(getSessionToken()).toBe('')
    expect(localStorage.getItem('aliangboard.platform')).toBe('plat-token') // 平台登录保留
    expect(window.location.pathname).toBe('/select-cluster')               // 重新选集群,不是重新登录
  })

  it('已在 /select-cluster 时会话过期 401 不重复整页跳转', async () => {
    saveSession('stale-k8s-token', true)
    window.location.href = 'http://localhost/select-cluster'
    fetchMock.mockResolvedValue(res401())
    await expect(api.k8s('/api/v1/namespaces')).rejects.toMatchObject({ status: 401 })
    expect(window.location.pathname).toBe('/select-cluster')
  })
})

describe('平台层 401 语义(不变,回归锁定)', () => {
  let fetchMock
  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock
    localStorage.clear(); sessionStorage.clear()
    window.location.href = 'http://localhost/select-cluster'
  })
  afterEach(() => { delete global.fetch })

  it('登录接口自身 401 = 凭据错误:不清不跳(交页面提示)', async () => {
    savePlatformToken('stale') // 若误清,用户需重输;设计上保留交调用方
    fetchMock.mockResolvedValue(res401('用户名或密码错误'))
    await expect(authApi.login({ username: 'a', password: 'b' })).rejects.toMatchObject({ status: 401 })
    expect(window.location.pathname).toBe('/select-cluster')
    expect(localStorage.getItem('aliangboard.platform')).toBe('stale')
  })

  it('其余平台接口 401 = 平台会话过期:清 token 跳 /login', async () => {
    savePlatformToken('stale')
    fetchMock.mockResolvedValue(res401())
    await expect(authApi.myClusters()).rejects.toMatchObject({ status: 401 })
    expect(localStorage.getItem('aliangboard.platform')).toBeNull()
    expect(window.location.pathname).toBe('/login')
  })
})

// W3 §1.5 外评修复 2:admin 强制 MFA 开关下的受限 token——平台接口 403 {code:'MFA_ENROLLMENT_REQUIRED'}。
// 语义:不清凭据(受限 token 仍有效),整页跳个人中心安全 tab 引导启用;已在 /profile 不跳
// (安全页自身非白名单请求如会话列表同样 403,反复跳=刷新死循环);普通 403(无 code)留在原页。
describe('平台层 403 MFA 受限语义', () => {
  let fetchMock
  function res403(payload) {
    const text = JSON.stringify(payload)
    return { ok: false, status: 403, text: async () => text }
  }
  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock
    localStorage.clear(); sessionStorage.clear()
  })
  afterEach(() => { delete global.fetch })

  it('受限 403 → 跳 /profile?tab=security;平台凭据保留', async () => {
    savePlatformToken('restricted-token')
    window.location.href = 'http://localhost/workbench'
    fetchMock.mockResolvedValue(res403({ message: '管理员已要求启用两步验证', code: 'MFA_ENROLLMENT_REQUIRED' }))
    await expect(authApi.myClusters()).rejects.toMatchObject({ status: 403 })
    expect(window.location.pathname).toBe('/profile')
    expect(window.location.search).toContain('tab=security')
    expect(localStorage.getItem('aliangboard.platform')).toBe('restricted-token')
  })

  it('已在 /profile 时不重复整页跳转(防刷新循环)', async () => {
    savePlatformToken('restricted-token')
    window.location.href = 'http://localhost/profile?tab=security'
    fetchMock.mockResolvedValue(res403({ message: '管理员已要求启用两步验证', code: 'MFA_ENROLLMENT_REQUIRED' }))
    await expect(authApi.listSessions()).rejects.toMatchObject({ status: 403 })
    expect(window.location.pathname).toBe('/profile')
    expect(window.location.search).toBe('?tab=security')
  })

  it('普通 403(无 code)= 权限不足:留在原页不动', async () => {
    savePlatformToken('tok')
    window.location.href = 'http://localhost/admin/users'
    fetchMock.mockResolvedValue(res403({ message: 'admin required' }))
    await expect(authApi.myClusters()).rejects.toMatchObject({ status: 403 })
    expect(window.location.pathname).toBe('/admin/users')
  })
})
