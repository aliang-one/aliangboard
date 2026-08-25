import { createI18n } from 'vue-i18n'
import zh from './locales/zh.json'
import en from './locales/en.json'

// 浏览器外（vitest/SSR）localStorage 可能未就绪或不完整——防御性读取，行为与浏览器一致。
const saved = (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function')
  ? localStorage.getItem('aliangboard.locale')
  : null

const initial = saved || 'zh'

// 启动即同步 <html lang>（index.html 写死的 zh-CN 只是无 JS 时的兜底默认）
if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.lang = initial === 'zh' ? 'zh-CN' : 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: initial,
  fallbackLocale: 'en',
  messages: { zh, en },
})

export function setLocale(l) {
  i18n.global.locale.value = l
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  }
  if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
    localStorage.setItem('aliangboard.locale', l)
  }
}
