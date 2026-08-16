// 模块加载冒烟：import src/ 下每一个 .js/.vue 模块，捕获任何**模块加载期**抛错。
// 目的：覆盖 useResourceMappers 那类「顶层引用未定义变量」(如 ref is not defined) 的 bug
// —— 这类错只在模块求值时炸，typecheck/build 都抓不到。view 挂载套件只 import 了 views，
// 本套件补上 composables/stores/api/data/components 的加载覆盖。
import { test, expect } from 'vitest'

// 排除：入口(main.js 会 mount #app)、测试自身(含 node:test 风格 .test.mjs——vitest.config 只收 .js,见其注释)、fixture。loader 是惰性的，跳过 key 即不加载。
const SKIP = /(^|\/)(main\.js|.*\.test\.[a-z]+(\.[a-z]+)*|.*\.spec\.js|__tests__|fixtures)\b/
const mods = import.meta.glob('/src/**/*.{js,mjs,vue}')

let n = 0
for (const [path, loader] of Object.entries(mods)) {
  if (SKIP.test(path)) continue
  n++
  test(`import ${path.replace('/src/', '')}`, async () => {
    let mod
    try {
      mod = await loader()
    } catch (e) {
      throw new Error(`${path} 加载失败：${e?.message || e}`)
    }
    expect(mod, `${path} 应能被 import`).toBeDefined()
  })
}
// 兜底：确保 glob 真的命中了模块（防止配置失效静默 0 用例通过）
test('模块导入套件至少覆盖 1 个模块', () => {
  expect(n, 'import.meta.glob 未命中任何模块，检查 SKIP/路径').toBeGreaterThan(0)
})
