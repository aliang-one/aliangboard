// taskbarFit.nextFitStep 用例表:三层递进(收窄→折叠→回收)判定
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { nextFitStep } from './taskbarFit.js'

const cases = [
  // [name, input, expected action]
  ['空间充足且无折叠 → done', { scrollWidth: 100, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'done'],
  ['溢出且未收窄 → set-icon(第一层)', { scrollWidth: 500, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'set-icon'],
  ['已收窄仍溢出 → fold-one(第二层)', { scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3 }, 'fold-one'],
  ['已收窄且已折 2/3 仍溢出 → 继续 fold-one', { scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 2, total: 3 }, 'fold-one'],
  ['全部折叠仍溢出 → done(兜底,接受滚动裁切)', { scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 3, total: 3 }, 'done'],
  ['折叠后空间回富(recover 放行)→ unfold-one(逆向回收)', { scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 2, total: 3, direction: 'recover' }, 'unfold-one'],
  ['收窄后空间回富且无折叠(recover 放行)→ unset-icon(恢复名称)', { scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3, direction: 'recover' }, 'unset-icon'],
  ['放得下且缺省 shrink → done(锁定,不自动回收)', { scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3 }, 'done'],
  ['恰好临界(+1px 在容差内)→ done', { scrollWidth: 401, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'done'],
  ['超容差 2px → set-icon', { scrollWidth: 402, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'set-icon'],
]

for (const [name, input, expected] of cases) {
  test(`taskbarFit: ${name}`, () => {
    assert.equal(nextFitStep(input).action, expected)
  })
}

// ===== 2026-09-05 收敛契约:direction 单向闸门 + runFitLoop 组合环仿真 =====
// 缺陷史:旧决策器在「测量→决策→应用→再测量」闭环下负反馈振荡——名称放不下 → set-icon,
// 图标放得下(且无折叠)→ unset-icon,如此往复打满 60 轮上限后停在任意奇偶态。宽屏多终端
// 稳态恰好落在 iconMode=false:名称平铺 + overflow-hidden 裁掉尾部 + 「⋯」永不出现
// (用户报告「部分 terminal 找不到」的根因)。旧用例表逐动作钉值、从未组合闭环,故全绿漏报。
// 新契约:direction='shrink'(缺省)只收不放、放得下即锁;'recover' 由组件在 chip 减少/容器
// 变宽时放行,逐级回收,试探过头立即降回 shrink 并锁定(单向闸门,闭环必收敛)。

const importFit = () => import('./taskbarFit.js')

// —— direction 语义单用例(纯函数,静态 nextFitStep 即可断言)——
test('taskbarFit: shrink(缺省)且放得下 → done 锁定,不再 unset-icon(振荡修复核心)', () => {
  // 旧版此处返回 unset-icon → 闭环下与 set-icon 打摆
  assert.equal(nextFitStep({ scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3 }).action, 'done')
  assert.equal(nextFitStep({ scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3, direction: 'shrink' }).action, 'done')
})
test('taskbarFit: recover 放得下且有折叠 → unfold-one(逐级回收)', () => {
  const step = nextFitStep({ scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 2, total: 3, direction: 'recover' })
  assert.equal(step.action, 'unfold-one')
})
test('taskbarFit: recover 放得下无折叠已收窄 → unset-icon(最后一级回收)', () => {
  const step = nextFitStep({ scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3, direction: 'recover' })
  assert.equal(step.action, 'unset-icon')
})
test('taskbarFit: recover 放得下全显名称 → done 且降回 shrink(回收到顶锁定)', () => {
  const step = nextFitStep({ scrollWidth: 200, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3, direction: 'recover' })
  assert.equal(step.action, 'done')
  assert.equal(step.dir, 'shrink')
})
test('taskbarFit: recover 试探过头(溢出)→ 收缩动作并降回 shrink(单向闸门)', () => {
  const up = nextFitStep({ scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3, direction: 'recover' })
  assert.equal(up.action, 'fold-one')
  assert.equal(up.dir, 'shrink')
  const up2 = nextFitStep({ scrollWidth: 500, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3, direction: 'recover' })
  assert.equal(up2.action, 'set-icon')
  assert.equal(up2.dir, 'shrink')
})

// —— 组合环仿真:用宽度模型模拟 DOM 测量,驱动与组件同源的 runFitLoop 闭环 ——

// DOM 宽度模型:名称态按各 chip 实宽排布,图标态统一 iconW,折叠时尾部加「⋯」按钮宽。
// 真实布局里 chip shrink-0 + wrap overflow-hidden,scrollWidth=可见 chip 宽度和。
function makeTaskbarModel({ nameWidths, iconW = 48, moreW = 56, clientWidth }) {
  const state = { iconMode: false, overflowCount: 0, direction: 'shrink' }
  const measure = () => {
    const total = nameWidths.length
    const visible = total - state.overflowCount
    let w = 0
    for (let i = 0; i < visible; i++) w += state.iconMode ? iconW : nameWidths[i]
    if (state.overflowCount > 0) w += moreW
    return { scrollWidth: w, clientWidth }
  }
  const model = { state, measure, total: nameWidths.length }
  model.drive = async () => {
    const { runFitLoop } = await importFit()
    return runFitLoop({
      measure: model.measure,
      getTotal: () => model.total,
      getDirection: () => model.state.direction,
      setDirection: d => { model.state.direction = d },
      getIconMode: () => model.state.iconMode,
      setIconMode: v => { model.state.iconMode = v },
      getOverflowCount: () => model.state.overflowCount,
      setOverflowCount: v => { model.state.overflowCount = v },
    })
  }
  return model
}

const WIDE = 900   // 模拟宽屏下任务栏可折叠区宽度(px)

test('组合环仿真: 宽屏 12 终端(用户事故场景)必收敛、最终不裁切、无 ⋯ 也可接受', async () => {
  // 名称 150-220px/枚 ≈ 2200px 总宽 ≫ 900;图标 48px/枚 = 576px 放得下
  const m = makeTaskbarModel({ nameWidths: Array.from({ length: 12 }, (_, i) => 150 + (i % 8) * 10), clientWidth: WIDE })
  const r = await m.drive()
  assert.equal(r.converged, true, '闭环必须收敛(旧实现 set-icon↔unset-icon 振荡)')
  assert.ok(r.iterations < 60, `应在迭代上限内收敛,实际 ${r.iterations}`)
  const { scrollWidth } = m.measure()
  assert.ok(scrollWidth <= WIDE, `最终不得裁切: scrollWidth=${scrollWidth} > clientWidth=${WIDE}`)
  assert.equal(m.state.overflowCount, 0, '图标态放得下时不应折叠')
  assert.equal(m.state.iconMode, true, '应锁定在图标态')
})

test('组合环仿真: 窄屏 12 终端必收敛,折叠到放得下为止(⋯ 出现)', async () => {
  const m = makeTaskbarModel({ nameWidths: Array.from({ length: 12 }, () => 180), clientWidth: 300 })
  const r = await m.drive()
  assert.equal(r.converged, true)
  const { scrollWidth } = m.measure()
  assert.ok(scrollWidth <= 300, `最终不得裁切: scrollWidth=${scrollWidth} > 300`)
  assert.ok(m.state.overflowCount > 0, '窄屏应折叠进 ⋯')
})

test('组合环仿真: recover 逐级回收——图标态全显放得下后试探名称,过头即降级锁定', async () => {
  // 预置:已折叠 6 枚 + 图标态(收缩后的稳态);用户关掉若干 chip → 组件置 recover
  const m = makeTaskbarModel({ nameWidths: Array.from({ length: 12 }, () => 180), clientWidth: WIDE })
  m.state.iconMode = true
  m.state.overflowCount = 6
  m.state.direction = 'recover'
  const r = await m.drive()
  assert.equal(r.converged, true)
  // 12×48=576 ≤ 900:图标全显放得下 → oc 回收到 0 → 试探 unset-icon → 名称 2160 > 900 → 降回
  assert.equal(m.state.overflowCount, 0, '折叠应逐级回收到 0')
  assert.equal(m.state.iconMode, true, '名称放不下应回到图标态')
  assert.equal(m.state.direction, 'shrink', '试探过头后锁定收缩向')
  const { scrollWidth } = m.measure()
  assert.ok(scrollWidth <= WIDE)
})

test('组合环仿真: recover 边界过头只回弹一次即锁定(不振荡)', async () => {
  const m = makeTaskbarModel({ nameWidths: Array.from({ length: 12 }, () => 180), clientWidth: 350 })
  m.state.iconMode = true
  m.state.overflowCount = 6   // 6×48+56=344 ≤ 350:起步放得下
  m.state.direction = 'recover'
  const r = await m.drive()
  assert.equal(r.converged, true)
  // unfold → oc=5: 7×48+56=392 > 350 试探过头 → fold-one 降级回 oc=6(344 ≤ 350)→ done
  assert.equal(m.state.overflowCount, 6)
  assert.equal(m.state.direction, 'shrink')
  assert.ok(r.iterations <= 4, `边界回弹应一步到位,实际 ${r.iterations} 轮`)
})

test('组合环仿真: 名称全放得下时 recover 一路回收到全显名称', async () => {
  const m = makeTaskbarModel({ nameWidths: [160, 170, 180], clientWidth: WIDE })
  m.state.iconMode = true
  m.state.overflowCount = 2
  m.state.direction = 'recover'
  const r = await m.drive()
  assert.equal(r.converged, true)
  assert.equal(m.state.overflowCount, 0)
  assert.equal(m.state.iconMode, false, '名称放得下应恢复名称态')
  assert.equal(m.state.direction, 'shrink')
})
