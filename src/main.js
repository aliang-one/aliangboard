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
import { initTheme } from './styles/theme'
initTheme()   // 注入亮/暗双板 CSS 变量 + 恢复主题(localStorage 兜底)+ 挂定时边界 tick(7/19 点自动翻转)

// 弹窗页(/terminal-popup、/log-popup)的 K8s session token 交接:opener 写 localStorage 交接槽
// (读后即焚),弃用 URL ?token= 传参(token 会进浏览器历史,2026-09-04);sessionStorage 不跨
// 标签页,故需交接。旧 URL 参数兼容保留。仅弹窗路由消费,主应用不受交接槽残留影响。
// 2026-09-07:消费分支从仅 /terminal-popup 扩到 /log-popup(此前漏掉 → 日志弹窗恒报会话已过期),
// 槽键/路径白名单收敛在 logic/popupToken.js。
import { consumePopupToken } from './logic/popupToken'
consumePopupToken()

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
