import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: process.env.ALIANGBOARD_API_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true, // 代理 WebSocket 升级（/api/exec 终端需要）
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
