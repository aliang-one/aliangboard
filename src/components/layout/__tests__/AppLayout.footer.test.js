// AppLayout 过重不挂载(项目惯例,见 AppLayout.atmosphere.test.js 头注):静态源断言。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const layoutSrc = readFileSync('./src/components/layout/AppLayout.vue', 'utf8')

test('顶栏已退役:不再 import/挂载 TopNavBar', () => {
  expect(layoutSrc).not.toContain('TopNavBar')
})

test('footer 刷新:bumpRefresh + invalidateAllClusterQueries + 自旋窗', () => {
  expect(layoutSrc).toMatch(/function refreshPage\(\)/)
  expect(layoutSrc).toContain('bumpRefresh()')
  expect(layoutSrc).toContain('store.invalidateAllClusterQueries()')
  expect(layoutSrc).toContain('data-test="footer-refresh"')
})

test('footer 手机档:汉堡(toggleDrawer)与告警 AlertBell 均belowSm门控(RF1)', () => {
  expect(layoutSrc).toContain('data-test="footer-menu"')
  expect(layoutSrc).toMatch(/v-if="belowSm"[\s\S]{0,200}data-test="footer-menu"/)
  expect(layoutSrc).toMatch(/<AlertBell v-if="belowSm"/)
})

test('集群健康横幅/UpdateBanner 仍在(main 之前)', () => {
  expect(layoutSrc).toContain('clusterHealth')
  expect(layoutSrc).toContain('<UpdateBanner')
})
