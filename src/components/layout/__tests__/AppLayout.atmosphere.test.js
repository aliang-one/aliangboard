// 氛围画布静态契约(spec 2026-09-05 §2):workbench 三路由打 module 标记 → AppLayout main
// 挂 wb-atmosphere → main.css 三层(绿雾本体/辉光 ::before/点阵 ::after)+ reduced-motion。
// AppLayout 过重不挂载(happy-dom 拖全站),静态源断言 + Task 6 浏览器验收互补。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(p, 'utf8')
const routerSrc = read('./src/router/index.js')
const layoutSrc = read('./src/components/layout/AppLayout.vue')
const cssSrc = read('./src/styles/main.css')

test('router:workbench 三路由(module 标记 ×3)且 ledger 归队 fullHeight', () => {
  expect((routerSrc.match(/module: 'workbench'/g) || []).length).toBe(3)
  // ledger 路由行:文档式 → 舞台域
  expect(routerSrc).toMatch(/workbench\/ledger[\s\S]{0,220}fullHeight: true/)
})

test('AppLayout:main 按 meta.module 挂 wb-atmosphere,包裹层 relative 压住伪元素层级', () => {
  expect(layoutSrc).toContain("'wb-atmosphere'")
  expect(layoutSrc).toContain('relative')
})

test('main.css:三层俱全(绿雾本体/辉光 ::before/点阵 ::after)+ 辉光 bloom + reduced-motion', () => {
  expect(cssSrc).toContain('.wb-atmosphere')
  expect(cssSrc).toContain('.wb-atmosphere::before')
  expect(cssSrc).toContain('.wb-atmosphere::after')
  expect(cssSrc.match(/\.wb-atmosphere(::before|::after| \.|\{)/g)?.length).toBeGreaterThanOrEqual(4) // 本体+亮暗分档
  expect(cssSrc).toContain('92% 0%')            // 辉光原点=右上(舷板方位)
  expect(cssSrc).toContain('@keyframes wb-glow-in')
  expect(cssSrc).toContain('background-size: 24px 24px')  // 点阵网格
  const reduce = cssSrc.slice(cssSrc.indexOf('prefers-reduced-motion', cssSrc.indexOf('wb-atmosphere')))
  expect(reduce).toContain('wb-atmosphere::before')
})
