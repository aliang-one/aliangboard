import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 前端测试配置（vitest + happy-dom + @vue/test-utils）。
// 例外于仓库「禁止新增外部依赖」政策 —— 见 CLAUDE.md「依赖政策例外」。
// 服务端 node --test 与 scripts/test.mjs 零依赖运行器保留不变。
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.{test,spec}.{js,mjs}', 'tests/**/*.{test,spec}.{js,mjs}'],
  },
})
