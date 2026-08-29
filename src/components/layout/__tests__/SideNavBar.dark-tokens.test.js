// 暗色亮岛防线(2026-08-29 用户报告):SideNavBar 的 <style> 块曾整片硬编码亮色
// (#fff/#f4f8f5/#e9efeb/#bbcabf/#0b1c30…),不随 html.dark 切换 → ns 坞与底部停靠坞
// 在暗色下仍是白色孤岛。既往盘点正则只扫 6 位 hex 与 tailwind bg-white 类,漏掉了
// 原始 CSS 里的 3 位 hex。本守卫按「声明级」扫描样式块:
//   - background*/border*/box-shadow*/outline* 声明中出现任何硬编码 hex → 违规
//     (品牌绿渐变/LED 白名单豁免:0ba874/00835b/006747/00a173/005c3f/8bf5be,两主题皆正确);
//   - color: 声明允许 #fff/#ffffff(品牌绿面上的白字),其余 hex 同样违规(应走 token)。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'SideNavBar.vue'), 'utf8')
const style = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] || ''

const BRAND_HEX = new Set(['0ba874', '00835b', '006747', '00a173', '005c3f', '8bf5be'])
const PAINT_DECL = /(^|[{;\s(])(background|border|box-shadow|outline|drop-shadow)/

function violations() {
  const out = []
  style.split('\n').forEach((line, i) => {
    for (const decl of line.split(';')) {
      const hexes = [...decl.matchAll(/#([0-9a-fA-F]{3,6})\b/g)].map(m => m[1].toLowerCase())
      if (!hexes.length) continue
      const isPaint = PAINT_DECL.test(decl)
      for (const h of hexes) {
        if (BRAND_HEX.has(h)) continue
        if (!isPaint && /^f{3,6}$/.test(h)) continue // color:#fff:品牌绿面上的白字,两主题皆正确
        out.push(`L${i + 1}: ${decl.trim().slice(0, 60)} → #${h}`)
      }
    }
  })
  return out
}

test('SideNavBar 样式块禁硬编码亮色(暗色亮岛防线)', () => {
  expect(violations()).toEqual([])
})

test('侧栏配色走 CSS 变量 token(随 html.dark 级联切换)', () => {
  const used = [...style.matchAll(/var\(--md-sys-color-([a-z-]+)\)/g)].map(m => m[1])
  expect(new Set(used).size).toBeGreaterThanOrEqual(6)
  for (const token of ['surface-container-low', 'surface-container-lowest', 'outline-variant', 'on-surface', 'primary']) {
    expect(used, `缺 token: ${token}`).toContain(token)
  }
})
