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
import { setRowsPerPageDefault } from '@/utils/rowsPerPage'

const LOCALE_KEY = 'aliangboard.locale'
const THEME_KEY = 'aliangboard.theme'

function readStorage(key) {
  try { const v = localStorage.getItem(key); return v || null } catch { return null }
}

export const usePreferencesStore = defineStore('preferences', () => {
  const language = ref(readStorage(LOCALE_KEY))  // 'en' | 'zh' | null(未设置 → i18n 默认)
  const theme = ref(readStorage(THEME_KEY))      // 'light' | 'dark' | 'auto' | null(未设置 → auto)
  // Wave1 个人域新键(2026-09-04):账号级偏好,仅登录后由服务端 hydrate,不入 localStorage
  const landingView = ref(null)                  // 'clusters' | 'workbench' | null(未设置 → 默认)
  const defaultClusterId = ref(null)
  const defaultNamespace = ref(null)
  const rowsPerPage = ref(null)

  // 服务端为准覆盖(auth.login / authStore.fetchMe 拿到 prefs 后调用)
  function hydrateFromServer(prefs) {
    if (!prefs) return
    if (prefs.language && prefs.language !== language.value) { language.value = prefs.language; setLocale(prefs.language) }
    if (prefs.theme) {
      const t = prefs.theme === 'dark' || prefs.theme === 'light' ? prefs.theme : 'auto'
      if (t !== theme.value) { theme.value = t; applyThemeMode(t) }
    }
    if (prefs.landingView) landingView.value = prefs.landingView
    if (prefs.defaultClusterId) defaultClusterId.value = prefs.defaultClusterId
    if (prefs.defaultNamespace) defaultNamespace.value = prefs.defaultNamespace
    if (prefs.rowsPerPage) { rowsPerPage.value = prefs.rowsPerPage; setRowsPerPageDefault(prefs.rowsPerPage) }
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
  // Wave1 个人域 actions(模式同 setTheme:赋值 → persist)
  function setLandingView(v) {
    landingView.value = v
    persist()
  }
  function setDefaultClusterId(v) {
    defaultClusterId.value = v
    persist()
  }
  function setDefaultNamespace(v) {
    defaultNamespace.value = v
    persist()
  }
  function setRowsPerPage(n) {
    rowsPerPage.value = n
    setRowsPerPageDefault(n)
    persist()
  }
  function persist() {
    try {
      localStorage.setItem(LOCALE_KEY, language.value || '')
      localStorage.setItem(THEME_KEY, theme.value || '')
    } catch { /* 无 storage 环境 */ }
    // localStorage 双写仅保留 language/theme 两键——新键是账号级偏好,登录前无意义
    authApi.savePreferences({ language: language.value, theme: theme.value, landingView: landingView.value, defaultClusterId: defaultClusterId.value, defaultNamespace: defaultNamespace.value, rowsPerPage: rowsPerPage.value }).catch(() => { /* 离线兜底:本地已生效 */ })
  }
  return { language, theme, landingView, defaultClusterId, defaultNamespace, rowsPerPage, hydrateFromServer, setLanguage, setTheme, setLandingView, setDefaultClusterId, setDefaultNamespace, setRowsPerPage }
})
