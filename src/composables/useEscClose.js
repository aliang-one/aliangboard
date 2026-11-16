import { watch, onBeforeUnmount } from 'vue'
import { isImeKeyEvent } from '@/utils/imeKey'

// 模块级打开栈:只有栈顶(最后打开)的 modal 响应 ESC,避免层叠时一次 ESC 关掉多个。
// modal 都 Teleport 到 body、DOM 顺序与打开顺序一致,内存栈最廉价且可测。
const stack = []
let counter = 0

function isTop(id) {
  return stack.length > 0 && stack[stack.length - 1] === id
}

function removeFromStack(id) {
  const i = stack.indexOf(id)
  if (i >= 0) stack.splice(i, 1)
}

/**
 * 给 modal/对话框绑定「ESC 关闭」。ESC = Cancel = X = 点遮罩,直接关闭、不确认、不拦截。
 * @param {import('vue').Ref<boolean>} isOpenRef - 该 modal 是否打开(需为 ref/computed)。
 * @param {() => void} onClose - ESC 命中且本 modal 为栈顶时执行的关闭回调。
 */
export function useEscClose(isOpenRef, onClose) {
  const id = ++counter

  function onKeydown(e) {
    if (e.key !== 'Escape') return
    if (isImeKeyEvent(e)) return   // 组合期 Esc=取消候选词,不是关弹窗(否则输入半截全丢)
    if (!isOpenRef.value) return
    if (!isTop(id)) return
    onClose()
  }

  watch(isOpenRef, (open) => {
    if (open) {
      stack.push(id)
      document.addEventListener('keydown', onKeydown)
    } else {
      removeFromStack(id)
      document.removeEventListener('keydown', onKeydown)
    }
  }, { immediate: true })

  onBeforeUnmount(() => {
    removeFromStack(id)
    document.removeEventListener('keydown', onKeydown)
  })
}
