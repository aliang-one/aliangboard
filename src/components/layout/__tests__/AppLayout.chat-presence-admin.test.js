// 审计#7(2026-09-06):全局悬浮 AI 对话入口(ChatPresence)admin 专属——对话域(全部
// conversations 路由)恒 requireAdmin,非 admin 挂载只会得到恒 403 的 /conversations/active
// 10s 轮询。AppLayout 过重不挂载(happy-dom 拖全站),走静态源断言(模式同
// AppLayout.atmosphere.test.js / shell-width-guard.test.js),动态行为由 WorkbenchDetail
// 生命周期测试 + 浏览器验收互补。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const layoutSrc = readFileSync('./src/components/layout/AppLayout.vue', 'utf8')

test('AppLayout:ChatPresence 按 auth.isAdmin 门控——非 admin 不挂载悬浮对话入口', () => {
  expect(layoutSrc).toMatch(/<ChatPresence\s+v-if="auth\.isAdmin"\s*\/>/)
  // 模板消费 auth ⇒ script 必须实例化 store(裸引用会挂编译,双保险静态钉住)
  expect(layoutSrc).toMatch(/const auth = useAuthStore\(\)/)
})
