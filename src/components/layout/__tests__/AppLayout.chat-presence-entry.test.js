// contracts-07(2026-09-07 审计批次三,含 gap1-03):全局悬浮 AI 对话入口(ChatPresence)按
// 服务端实际门放行——W2 Phase D 对话域已降门 requirePlatform + owner 链(全部平台会话可建
// /看自己的对话;active 列表 owner 过滤见 conv-lifecycle-11),admin 专属口径(审计#7 时代)
// 作废。AppLayout 过重不挂载(happy-dom 拖全站),走静态源断言(模式同
// AppLayout.atmosphere.test.js / shell-width-guard.test.js),动态行为由 WorkbenchDetail
// 生命周期测试 + 浏览器验收互补。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const layoutSrc = readFileSync('./src/components/layout/AppLayout.vue', 'utf8')

test('AppLayout:ChatPresence 对全部平台会话无条件挂载——非 admin 同样可见悬浮对话入口', () => {
  expect(layoutSrc).toMatch(/<ChatPresence\s*\/>/)
  // admin 旧口径门控不得复活(v-if=isAdmin 会把入口对普通平台用户藏死)
  expect(layoutSrc).not.toMatch(/<ChatPresence[^>]*isAdmin/)
  expect(layoutSrc).not.toMatch(/<ChatPresence[^>]*v-if/)
})
