// src/logic/navConfig.test.mjs
// 导航单源自卫:①每条 route 尾段必须真实存在于 router/index.js(防手滑路径);
// ②NS_ROUTE_MAP 每个目标路由名存在;③跨 ns 组四条齐全(spec §6 补入口)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CLUSTER_PRIMARY_NAV, CLUSTER_CROSS_NS_NAV, CLUSTER_RESOURCES_NAV, CLUSTER_OTHER_NAV,
  PLATFORM_ADMIN_NAV, NS_NAV_GROUPS, NS_ROUTE_MAP, WORKBENCH_NAV,
} from './navConfig.js'

const routerSrc = readFileSync(new URL('../router/index.js', import.meta.url), 'utf8')
const ALL_NAV = [
  ...CLUSTER_PRIMARY_NAV, ...CLUSTER_CROSS_NS_NAV, ...CLUSTER_RESOURCES_NAV,
  ...CLUSTER_OTHER_NAV, ...PLATFORM_ADMIN_NAV, WORKBENCH_NAV,
]

test('navConfig:每条 route 在 router 中有 path 声明', () => {
  for (const it of ALL_NAV) {
    // router/index.js 的子路由一律不带前导斜杠声明(如 path: 'admin/users'、
    // path: 'cluster/certs'),brief 原稿的「尾段」匹配对 /admin/*、/cluster/certs
    // 这类多段真实路径误报(Step 6:以 router 真实路径为准)——改为整段匹配,
    // 比尾段匹配更强(钉死完整路径,非仅最后一段)。
    const decl = it.route.replace(/^\//, '')
    assert.match(routerSrc, new RegExp(`path: '${decl}'`), `route 不存在: ${it.route}`)
  }
})

test('navConfig:NS_ROUTE_MAP 目标路由名全部存在', () => {
  for (const name of Object.values(NS_ROUTE_MAP)) {
    assert.match(routerSrc, new RegExp(`name: '${name}'`), `路由名不存在: ${name}`)
  }
})

test('navConfig:跨 ns 组补齐 4 条无入口页面(spec §6)', () => {
  assert.deepEqual(
    CLUSTER_CROSS_NS_NAV.map(x => x.route).sort(),
    ['/configuration', '/network', '/rbac', '/workloads'],
  )
})

test('navConfig:形状契约(icon+labelKey 或 label+route;ns 组有 items)', () => {
  for (const it of ALL_NAV) {
    assert.ok(it.icon, `缺 icon: ${JSON.stringify(it)}`)
    assert.ok(it.route, `缺 route: ${JSON.stringify(it)}`)
    assert.ok(it.labelKey || it.label, `缺文案键: ${JSON.stringify(it)}`)
  }
  for (const g of NS_NAV_GROUPS) {
    assert.ok(g.labelKey || g.label)
    assert.ok(Array.isArray(g.items) && g.items.length > 0)
  }
})
