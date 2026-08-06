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
    include: ['src/**/*.{test,spec}.{js,mjs}', 'tests/**/*.{test,spec}.{js,mjs}'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
