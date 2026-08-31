// 侧栏宽度唯一事实源是 --sb-width(AppLayout <style> 定义);壳层出现 260px
// Tailwind 字面量即回归(2026-08-31 设计 §3/§9)。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const f of ['AppLayout.vue', 'TopNavBar.vue', 'SideNavBar.vue']) {
  test(`${f} 禁止 260px 定位/宽度字面量(一律走 --sb-width)`, () => {
    const src = readFileSync(join(dir, f), 'utf8')
    expect(src).not.toMatch(/ml-\[260px\]|left-\[260px\]|w-\[260px\]/)
  })
}
