import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/main.css'

// 终端弹窗（新标签页）从 URL 接收 session token 并写入 sessionStorage（同源但 sessionStorage 不跨标签页）
const popupToken = new URLSearchParams(window.location.search).get('token')
if (popupToken) {
  sessionStorage.setItem('aliangboard.session', popupToken)
}

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 在路由守卫之前初始化 auth store（从 localStorage 恢复平台 token）
import { useAuthStore } from './stores/auth'
useAuthStore(pinia).init()

app.use(router)
app.mount('#app')
