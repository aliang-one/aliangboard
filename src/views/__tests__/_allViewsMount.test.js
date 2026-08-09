// 全面冒烟：浅挂载每一个 view，捕获 setup/首渲期的运行期错误。
// 目的：数据层迁移（Vue Query）遗留的 bug 类——TDZ(cid)、未定义引用(recountNodePods)、
// 缺 .value(priorityClasses)、不可迭代等——typecheck/build 都抓不到，只有挂载才暴露。
// 一次跑完所有 view，给出完整清单，而不是用户逐页点击一个个撞。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// vue-router 桩：多数 view 用 useRoute().params.namespace / .name；给兜底假参。
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'default', name: 'demo', kind: 'Pod' }, query: {}, path: '/', meta: {} }),
  useRouter: () => ({ push: () => {}, replace: () => {}, go: () => {}, back: () => {} }),
  onBeforeRouteLeave: () => {},
  onBeforeRouteUpdate: () => {},
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))

// 桩 API 层:移除 mockMode 后,挂载时各 view 的 fetcher 会跑;
// 用 Proxy 让 api 任意方法都 resolved 空值,避免打真实后端 / 同步抛错。
vi.mock('@/api/client', () => {
  const noop = () => {}
  const api = new Proxy({}, { get: () => () => Promise.resolve({}) })
  return {
    api,
    k8sStream: () => ({ close: noop, abort: noop }),
    portForwardApi: new Proxy({}, { get: () => () => Promise.resolve([]) }),
    registryApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    terminalApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    podFileApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    podDebugApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    pvcFileApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    cronJobApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    resourceTreeApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    workbenchApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    authApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    adminApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    getSessionToken: () => '',
    saveSession: noop,
    clearSession: noop,
    getSession: () => null,
    getPlatformToken: () => '',
    savePlatformToken: noop,
    clearPlatformToken: noop,
    exportYaml: noop,
    getSavedClusters: () => [],
    addSavedCluster: noop,
    removeSavedCluster: noop,
    setActiveToken: noop,
    activeApiServer: () => '',
    execStream: () => ({ close: noop }),
  }
})

// localStorage 桩（happy-dom 此配置 getItem 非 fn），afterEach 还原避免污染其它套件。
let _ls, _ss
beforeEach(() => {
  _ls = globalThis.localStorage
  _ss = globalThis.sessionStorage
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
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

const modules = import.meta.glob('/src/views/**/*.vue')

for (const [path, loader] of Object.entries(modules)) {
  test(`mount ${path.replace('/src/views/', '')}`, async () => {
    setActivePinia(createPinia())
    const mod = await loader()
    const comp = mod.default
    expect(comp, `${path} 应有默认导出组件`).toBeTruthy()
    let wrapper
    try {
      wrapper = mount(comp, {
        shallow: true,
        global: {
          plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
          stubs: { RouterLink: true, RouterView: true },
        },
      })
    } catch (e) {
      // 抛出带文件名的清晰错误，便于定位
      const msg = e?.message || String(e)
      throw new Error(`${path} 挂载失败：${msg}`)
    } finally {
      wrapper?.unmount?.()
    }
    expect(true).toBe(true)
  })
}
