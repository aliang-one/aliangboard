import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 前端测试配置（vitest + happy-dom + @vue/test-utils）。
// 例外于仓库「禁止新增外部依赖」政策 —— 见 CLAUDE.md「依赖政策例外」。
// 服务端 node --test 与 scripts/test.mjs 零依赖运行器保留不变。
// resolve.alias 与 vite.config.js 对齐：被测模块（如 api/http.js 经 i18n.global.t）
// 会 import '@/i18n'，缺少该别名会导致 import-analysis 解析失败。
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: false,
    // 默认 5s 在高负载机器(多会话并行跑测试/vite)下会让重型用例(全模块 import/全视图 mount)
    // 偶发超时——提高全局上限,消除负载型假红(2026-08-25,实测 load 12-20 时 4 例轮替超时)。
    testTimeout: 20000,
    setupFiles: ['tests/setup.js'],
    // 只收 .js：.mjs 纯逻辑测试走 node:test（见 CLAUDE.md）。否则 vitest 会去抓
    // node:test 语法的 .test.mjs（如 resourceCatalog）并报 "No test suite found"。
    include: ['src/**/*.{test,spec}.js', 'tests/**/*.{test,spec}.js'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
