// 路由守卫「无 session 去留决策」的回归测试。
//
// 锁住的 bug:首次登录(全新部署,尚无任何集群)的 admin,在 /select-cluster 点
// 「添加集群」→ router.push('/admin/clusters') → 守卫因无 K8s session 且 tryAutoConnect
// 失败,把 admin 弹回 /select-cluster,形成「点了没反应」的死锁。
//
// 修复:平台管理类页面(meta.requiresCluster === false)不依赖「已连接某集群」,放行。
import { test, expect } from 'vitest'
import { resolveWhenSessionMissing } from '@/router/clusterGate'

// 返回 undefined = 放行;返回 { name: 'SelectCluster' } = 弹回选择页。
const CASES = [
  // [label, to, isPublic, 期望]
  ['admin 集群管理页(无 session)放行', { name: 'AdminClusters', meta: { requiresCluster: false } }, false, undefined],
  ['admin 用户管理页放行', { name: 'AdminUsers', meta: { requiresCluster: false } }, false, undefined],
  ['admin apikey 页放行', { name: 'AdminApiKeys', meta: { requiresCluster: false } }, false, undefined],
  ['普通资源页(非 public)弹回', { name: 'Workloads', meta: { scope: 'global' } }, false, { name: 'SelectCluster' }],
  ['namespace 页弹回', { name: 'NsPods', meta: { scope: 'namespace' }, params: { namespace: 'default' } }, false, { name: 'SelectCluster' }],
  ['SelectCluster 页(public)放行', { name: 'SelectCluster', meta: {} }, true, undefined],
  ['Login 页(public)放行', { name: 'Login', meta: {} }, true, undefined],
  ['meta 缺省(undefined)非 public 弹回', { name: 'Nodes', meta: undefined }, false, { name: 'SelectCluster' }],
  ['显式 requiresCluster:true 非 public 弹回', { name: 'Nodes', meta: { requiresCluster: true } }, false, { name: 'SelectCluster' }],
  ['to 本身为空时兜底弹回(健壮性)', undefined, false, { name: 'SelectCluster' }],
]

test('resolveWhenSessionMissing: 平台管理页放行,其余非 public 弹回', () => {
  for (const [label, to, isPublic, expected] of CASES) {
    const got = resolveWhenSessionMissing(to, isPublic)
    expect(got, `「${label}」期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(got)}`).toEqual(expected)
  }
})
