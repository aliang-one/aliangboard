// vitest 全局 setup（happy-dom 环境）。
//
// 背景：Node ≥ 21 在全局暴露了原生 localStorage/sessionStorage（空对象 / node:local_storage）。
// vitest 的 happy-dom 适配器用 `populateGlobal` 桥接 Window 属性时，对「已存在于 global」
// 的键只保留白名单内者，而 localStorage 不在白名单 → Node 原生的空 localStorage 泄漏进测试，
// 导致 `localStorage.clear()` 抛 `is not a function`。
//
// 本文件用 fresh happy-dom Window 实例的 Storage 覆盖全局，保证浏览器语义。
// 见 vitest getWindowKeys 对 `k in global` 的处理（dist/chunks/index.*.js）。
import { Window } from 'happy-dom'

const __win = new Window()

Object.defineProperty(globalThis, 'localStorage', {
  value: __win.localStorage,
  configurable: true,
  writable: true,
})
Object.defineProperty(globalThis, 'sessionStorage', {
  value: __win.sessionStorage,
  configurable: true,
  writable: true,
})

// vue-flow(拓扑连线画布)依赖 ResizeObserver 做节点尺寸测量;happy-dom 无此 API。
// 提供 no-op stub:回调挂 __cb 供用例手动触发(如需模拟尺寸变化)。
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    constructor(cb) { this.__cb = cb }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
