// Wave5 W2 Task8:overview 杂项配方落地(静态源码断言,先例 InteractiveTerminal.keys.test.js:
// happy-dom 下 import.meta.url 非 file 协议,静态断言统一走 cwd 相对路径)。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from 'vitest'

const src = readFileSync(resolve('src/views/NsWorkloadDetail.vue'), 'utf8')
const topo = readFileSync(resolve('src/components/common/WorkloadTopologyTab.vue'), 'utf8')

test('R10:指标双图手机单列;YAML 高度手机 60vh;diff 容器可横滚', () => {
  expect(src).toContain('grid-cols-1 md:grid-cols-2')
  expect(src).toContain(':height="isPhone ? \'60vh\' : \'560px\'"')
  // 同一 class 里 overflow-hidden 与 whitespace-pre 并存 = diff 行横向被裁死(预检风险点:
  // 计划原片段此处括号失衡(expect(...).length) 悬挂右括号),按同语义修正为
  // expect((match || []).length).toBe(0)。仓库其余 overflow-hidden 卡壳均无
  // whitespace-pre 同 class 并存,本断言未见误报,按原样收编。
  expect((src.match(/overflow-hidden[^"]*whitespace-pre|whitespace-pre[^"]*overflow-hidden/) || []).length).toBe(0)
})

test('R9 触控:快速伸缩/时间窗/容器行/历史行钮四件套(after 命中区 ≥24)', () => {
  // 计划原估 ≥90 基于 T7 改造前的裸表逐行钮;T7 迁共享 DataTable 后命中区大头的
  // 行钮四件套落在 DataTable.vue(卡片/行双分支组件内),本文件只剩结构性按钮。
  // 实测:T4-T7 存量 14 处(逐处核过:版本卡×3/Pod 终端×2/回滚×1/编辑弹窗×6/
  // meta·expose 弹窗×3)+ 本任务 10 处(快速伸缩×2/时间窗×1/历史紧凑行×3/容器行×4)
  // = 24。阈值按实际计数收严(允许向下取实际值,不许虚高)。
  expect((src.match(/max-sm:after:-inset-2/g) || []).length).toBeGreaterThanOrEqual(24)
})

test('R10:label/configRef/port chip 可断行(break-all 在场 ≥7)', () => {
  // 存量 4 处(镜像/原因/事件对象名/新镜像预览)+ 本任务 3 chip = 7;阈值从计划的
  // ≥3 收严到 ≥7,钉住本任务新增(3 在改造前即已满足,不构成红测试)。
  expect((src.match(/break-all/g) || []).length).toBeGreaterThanOrEqual(7)
})

test('R10:编辑弹窗网格补断点(裸 grid-cols-3/4 全部带响应式变体)', () => {
  // 只判「无断点前缀的裸 grid-cols-[34]」:页面级摘要条 `md:grid-cols-3 xl:grid-cols-5`
  // 已带断点变体(基座 grid-cols-2),按计划例外放行——原版 includes('sm:grid-cols')
  // 过滤会把它永久误判(预检风险点:regex 收紧至裸变体,判废集只缩不扩)。
  const withCols = src.match(/class="[^"]*grid-cols-[34][^"]*"/g) || []
  const offending = withCols.filter(c => /(^|\s)grid-cols-[34](\s|$)/.test(c) && !c.includes('sm:grid-cols') && !c.includes('grid-cols-1'))
  expect(offending).toEqual([])
})

test('R11:拓扑画布手机 min-zoom 0.15', () => {
  expect(topo).toContain(':min-zoom="isPhone ? 0.15 : 0.5"')
})
