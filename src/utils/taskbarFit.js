// 任务栏折叠决策器(纯函数,用例表可测):
// 三层递进——①chip 名称收窄为图标 ②尾部 chip 逐个折进「⋯ n」下拉 ③空间回富时逆向回收。
// 组件侧解释 action 并在下一帧测量;本函数只做判定,不碰 DOM。
//
// 判定输入:scrollWidth/clientWidth(折叠行的实际溢出量)、iconMode(图标收窄态)、
// overflowCount(已折叠条数)、total(可折叠条总数)、direction(收敛方向)。
//
// direction 单向闸门(2026-09-05 振荡修复):
// 旧版在闭环下对称打摆——名称放不下 → set-icon,图标放得下 → unset-icon,60 轮上限后停在
// 任意奇偶态(宽屏多终端稳态=名称平铺+裁切+「⋯」永不出现)。新版把「放↔收」改成单向:
// - 'shrink'(缺省):只收不放,放得下即锁定;
// - 'recover':组件检测到空间富余(chip 减少/容器变宽)时放行,逐级回收;试探过头立即降回
//   'shrink' 并锁定。每次 recover 至多一次回弹,闭环必收敛(runFitLoop 组合环仿真钉死)。
export function nextFitStep({ scrollWidth, clientWidth, iconMode, overflowCount, total, direction = 'shrink' }) {
  if (scrollWidth > clientWidth + 1) {
    if (direction === 'recover') {
      // 升级试探过头:降级回收缩向并锁定,本轮不再升级
      return iconMode ? { action: 'fold-one', dir: 'shrink' } : { action: 'set-icon', dir: 'shrink' }
    }
    if (!iconMode) return { action: 'set-icon' }
    if (overflowCount < total) return { action: 'fold-one' }
    return { action: 'done' }
  }
  if (direction === 'shrink') return { action: 'done' }
  if (overflowCount > 0) return { action: 'unfold-one' }
  if (iconMode) return { action: 'unset-icon' }
  return { action: 'done', dir: 'shrink' }
}

// 收敛循环驱动器:组件与组合环仿真共用的「测量→决策→应用→再测量」闭环本体。
// 组件传 nextTick 作 tick(DOM 重排后测),仿真传同步 no-op;converged=false 即振荡,回归红线。
export async function runFitLoop({
  measure, getTotal, getDirection, setDirection,
  getIconMode, setIconMode, getOverflowCount, setOverflowCount,
  tick = () => {}, maxIters = 60,
}) {
  for (let i = 0; i < maxIters; i++) {
    const { scrollWidth, clientWidth } = measure()
    const step = nextFitStep({
      scrollWidth, clientWidth,
      iconMode: getIconMode(), overflowCount: getOverflowCount(),
      total: getTotal(), direction: getDirection(),
    })
    if (step.dir) setDirection(step.dir)
    if (step.action === 'done') return { converged: true, iterations: i }
    if (step.action === 'set-icon') setIconMode(true)
    else if (step.action === 'unset-icon') setIconMode(false)
    else if (step.action === 'fold-one') setOverflowCount(getOverflowCount() + 1)
    else if (step.action === 'unfold-one') setOverflowCount(getOverflowCount() - 1)
    await tick()
  }
  return { converged: false, iterations: maxIters }
}
