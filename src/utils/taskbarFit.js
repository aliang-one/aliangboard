// 任务栏折叠决策器(纯函数,用例表可测):
// 三层递进——①chip 名称收窄为图标 ②尾部 chip 逐个折进「⋯ n」下拉 ③空间回富时逆向回收。
// 组件侧解释 action 并在下一帧测量;本函数只做判定,不碰 DOM。
//
// 判定输入:scrollWidth/clientWidth(折叠行的实际溢出量)、iconMode(图标收窄态)、
// overflowCount(已折叠条数)、total(可折叠条总数)。
export function nextFitStep({ scrollWidth, clientWidth, iconMode, overflowCount, total }) {
  if (scrollWidth <= clientWidth + 1) {
    if (overflowCount > 0) return { action: 'unfold-one' }
    if (iconMode) return { action: 'unset-icon' }
    return { action: 'done' }
  }
  if (!iconMode) return { action: 'set-icon' }
  if (overflowCount < total) return { action: 'fold-one' }
  return { action: 'done' }
}
