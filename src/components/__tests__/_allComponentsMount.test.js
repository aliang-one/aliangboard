// 组件挂载冒烟：浅挂载 src/components 下每一个组件，捕获 setup/首渲期抛错。
// 与 view 套件互补——view 套件浅挂载会 stub 掉子组件，子组件自身的崩溃看不到；本套件补这块。
// 自动按 defineProps 的类型给 required prop 塞兜底值（[]/{} /false/0/'x'），避免「缺 prop」这种
// 非真 bug 的噪音；optional/有 default 的 prop 不塞（走默认值）。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'default', name: 'demo', kind: 'Pod' }, query: {}, path: '/', meta: {} }),
  useRouter: () => ({ push: () => {}, replace: () => {}, go: () => {}, back: () => {} }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))

let _ls, _ss
beforeEach(() => {
  _ls = globalThis.localStorage; _ss = globalThis.sessionStorage
  const mem = new Map()
  const shim = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null, get length() { return mem.size } }
  globalThis.localStorage = shim; globalThis.sessionStorage = shim
})
afterEach(() => { globalThis.localStorage = _ls; globalThis.sessionStorage = _ss })

// 按 prop 类型给兜底值
function stubProps(comp) {
  const out = {}
  for (const [name, def] of Object.entries(comp.props || {})) {
    const d = def && typeof def === 'object' ? def : { type: def }
    if (d.required !== true) continue          // optional / 有 default：跳过
    const t = d.type
    if (t === Array) out[name] = []
    else if (t === Object) out[name] = {}
    else if (t === Boolean) out[name] = false
    else if (t === Number) out[name] = 0
    else if (t === String) out[name] = ''
    else out[name] = {}                          // 未声明类型(defineModel/复杂对象) → 给对象，避免 '' 上设属性
  }
  return out
}

// 少数组件的 required prop 是有限枚举（如 NodeActions.action ∈ cordon/uncordon/drain），
// 兜底 '' 不是合法键 → 需显式给一个合法值。仅这些特例在此登记。
const PROP_OVERRIDE = {
  'components/common/NodeActions.vue': { nodeName: 'node-1', action: 'drain' },
}

// inject 驱动的组件：挂载时依赖外部 provide 上下文（如 'fileExplorer'），
// 本套件不提供该上下文 → 跳过冒烟挂载（功能由各自的专属测试覆盖）。
const SKIP_INJECT = new Set([
  'components/common/FileTree.vue',
  'components/common/FileTreeNode.vue',
])

const mods = import.meta.glob('/src/components/**/*.vue')
let n = 0
for (const [path, loader] of Object.entries(mods)) {
  n++
  const rel = path.replace('/src/', '')
  if (SKIP_INJECT.has(rel)) {
    test.skip(`mount ${rel} (跳过：依赖 inject 上下文)`, () => {})
    continue
  }
  test(`mount ${rel}`, async () => {
    setActivePinia(createPinia())
    const mod = await loader()
    const comp = mod.default
    expect(comp, `${path} 应有默认导出`).toBeTruthy()
    let wrapper
    try {
      wrapper = mount(comp, {
        shallow: true,
        props: { ...stubProps(comp), ...(PROP_OVERRIDE[rel] || {}) },
        global: {
          plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
          stubs: { RouterLink: true, RouterView: true },
        },
      })
    } catch (e) {
      throw new Error(`${path} 挂载失败：${e?.message || e}`)
    } finally {
      wrapper?.unmount?.()
    }
    expect(true).toBe(true)
  })
}
test('组件挂载套件至少覆盖 1 个组件', () => { expect(n).toBeGreaterThan(0) })
