import { test, expect } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useClusterStore } from '@/stores/cluster'

// 回归：mapper 抽取到 useResourceMappers.js 时，曾把依赖 store 内部状态的函数
// (recountNodePods / Pod·Event watch / fetchCRDs / attachRolloutHistory) 一并搬走并从
// cluster.js 删除，却没有 import 回来。后果：
//   1) useResourceMappers.js 模块顶层 `eventWatchLive = ref(false)` 但未 import ref →
//      模块加载即 ReferenceError → cluster.js import 失败 → 整个应用白屏；
//   2) 即便绕过，cluster.js setup 顶层调用 recountNodePods()、return 对象引用 startPodWatch
//      等 → 同样 ReferenceError，store 无法实例化。
// 此测试实例化真实 store，确保这些 store 方法存在且初始化不抛。
//
// 注意：本配置下 happy-dom 的 localStorage.getItem 不是函数（--localstorage-file 警告），
// 而 store setup 顶层会经 getSavedClusters()/activeApiServer()/currentNamespace 读 localStorage，
// 故先垫一个内存实现——这正是既有组件测试选择 mock @/stores/cluster 的同一原因。
function installStorageShim() {
  const mem = new Map()
  const shim = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
    clear: () => mem.clear(),
    key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  globalThis.localStorage = shim
  globalThis.sessionStorage = shim
}

test('cluster store 实例化不抛 + watch/CRD 方法齐备', () => {
  installStorageShim()
  setActivePinia(createPinia())
  const store = useClusterStore()
  const methods = ['startPodWatch', 'stopPodWatch', 'startEventWatch', 'stopEventWatch', 'eventsFor', 'fetchCRDs']
  for (const fn of methods) {
    expect(typeof store[fn], `${fn} 应为函数`).toBe('function')
  }
})
