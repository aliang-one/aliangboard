// 用户偏好 store(2026-08-29 用户中心设计 §2.4):language/theme 三级来源——
// ① localStorage 兜底(登录页/未登录);② 登录态建立时服务端 prefs 覆盖(hydrateFromServer);
// ③ 变更即时本地生效 + 双写(localStorage + PUT /api/auth/preferences,失败静默=离线兜底)。
// language 复用 src/i18n.js 的 setLocale(其 localStorage 键 aliangboard.locale 即本 store 的缓存键,
// Accept-Language 已由 http.js authHeaders 随 locale 发出,服务端消息语言自动跟随)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { authApi } from '@/api/client'
import { setLocale } from '@/i18n'
import { applyThemeMode } from '@/styles/theme'

const LOCALE_KEY = 'aliangboard.locale'
const THEME_KEY = 'aliangboard.theme'

function readStorage(key) {
  try { const v = localStorage.getItem(key); return v || null } catch { return null }
}

export const usePreferencesStore = defineStore('preferences', () => {
  const language = ref(readStorage(LOCALE_KEY))  // 'en' | 'zh' | null(未设置 → i18n 默认)
  const theme = ref(readStorage(THEME_KEY))      // 'light' | 'dark' | 'system' | null(未设置 → system)

  // 服务端为准覆盖(auth.login / authStore.fetchMe 拿到 prefs 后调用)
  function hydrateFromServer(prefs) {
    if (!prefs) return
    if (prefs.language && prefs.language !== language.value) { language.value = prefs.language; setLocale(prefs.language) }
    if (prefs.theme && prefs.theme !== theme.value) { theme.value = prefs.theme; applyThemeMode(prefs.theme) }
  }

  function setLanguage(lang) {
    language.value = lang
    setLocale(lang)
    persist()
  }
  function setTheme(mode) {
    theme.value = mode
    applyThemeMode(mode)
    persist()
  }
  function persist() {
    try {
      localStorage.setItem(LOCALE_KEY, language.value || '')
      localStorage.setItem(THEME_KEY, theme.value || '')
    } catch { /* 无 storage 环境 */ }
    authApi.savePreferences({ language: language.value, theme: theme.value }).catch(() => { /* 离线兜底:本地已生效 */ })
  }
  return { language, theme, hydrateFromServer, setLanguage, setTheme }
})
