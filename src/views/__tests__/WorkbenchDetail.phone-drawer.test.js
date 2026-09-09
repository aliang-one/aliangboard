// Wave5 W2 Task4(R6):对话列表/Edit 文件树手机收抽屉。模板重(WorkbenchChat/YamlEditor/
// vue-query),用静态源码断言钉住结构契约;行为验证走波末 390px 截图(计划 Task 9)。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'WorkbenchDetail.vue'), 'utf8')

test('R6 抽屉:Teleport 手机启用/桌面禁用,双抽屉开关钮在工具条', () => {
  expect(src).toContain(':disabled="!isPhone"')                       // 侧栏 Teleport
  expect((src.match(/:disabled="!isPhone"/g) || []).length).toBeGreaterThanOrEqual(2)
  expect(src).toContain('data-testid="open-conversations-btn"')
  expect(src).toContain('data-testid="open-files-btn"')
  expect(src).toContain('v-if="isPhone && mode === \'agent\'"')
  expect(src).toContain('v-if="isPhone && mode === \'edit\'"')
})

test('R6 抽屉:遮罩/面板走 Z 阶梯,选中即收(watch 收口)', () => {
  expect(src).toContain('Z.drawer - 1')
  expect(src).toContain('Z.drawer')
  expect(src).toContain('listDrawerOpen.value = false')
  expect(src).toContain('treeDrawerOpen.value = false')
})

test('触控四件套:对话重命名/删除 + 文件树删除钮补齐(≥5 处 after 命中区)', () => {
  expect((src.match(/max-sm:after:-inset-2/g) || []).length).toBeGreaterThanOrEqual(5)
})
