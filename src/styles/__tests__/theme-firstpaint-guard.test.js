// index.html 首帧内联脚本无法 import theme.js,定时边界 7/19 是双写镜像;
// 本守卫锁两处一致——单边改动 here 必红(2026-08-31 设计 §7)。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const themeSrc = readFileSync(join(root, 'src/styles/theme.js'), 'utf8')
const htmlSrc = readFileSync(join(root, 'index.html'), 'utf8')

test('theme.js 边界常量 7/19 存在', () => {
  expect(themeSrc).toContain('DARK_TO_HOUR = 7')
  expect(themeSrc).toContain('DARK_FROM_HOUR = 19')
})

test('index.html 内联脚本镜像同一边界表达式且不再读 prefers-color-scheme', () => {
  expect(htmlSrc).toMatch(/h < 7 \|\| h >= 19/)
  expect(htmlSrc).not.toContain('prefers-color-scheme')
})
