import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
// 字体自托管(@fontsource):离线 / 内网可用,不再依赖 Google Fonts CDN。
// Inter 4 个字重 + JetBrains Mono 2 个字重(与原 CDN 完全一致)+ Material Symbols 变量字体(wght+FILL 轴)。
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource-variable/material-symbols-outlined/fill.css'
import './styles/main.css'

// 终端弹窗（新标签页）从 URL 接收 session token 并写入 sessionStorage（同源但 sessionStorage 不跨标签页）
const popupToken = new URLSearchParams(window.location.search).get('token')
if (popupToken) {
  sessionStorage.setItem('aliangboard.session', popupToken)
}

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 服务端状态缓存层（TanStack Vue Query）：见 CLAUDE.md「依赖政策例外」。
// 默认 staleTime 15s + refetchOnWindowFocus：离开再回/切回标签页即后台重拉，缓解「数据迟钝」。
import { VueQueryPlugin } from '@tanstack/vue-query'
import { queryClient } from './queryClient'
app.use(VueQueryPlugin, { queryClient })

// 在路由守卫之前初始化 auth store（从 localStorage 恢复平台 token）
import { useAuthStore } from './stores/auth'
useAuthStore(pinia).init()

app.use(router)
app.use(i18n)
app.mount('#app')
