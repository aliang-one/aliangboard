import { createI18n } from 'vue-i18n'
import zh from './locales/zh.json'
import en from './locales/en.json'

// 浏览器外（vitest/SSR）localStorage 可能未就绪或不完整——防御性读取，行为与浏览器一致。
const saved = (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function')
  ? localStorage.getItem('aliangboard.locale')
  : null

export const i18n = createI18n({
  legacy: false,
  locale: saved || 'zh',
  fallbackLocale: 'en',
  messages: { zh, en },
})

export function setLocale(l) {
  i18n.global.locale.value = l
  if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
    localStorage.setItem('aliangboard.locale', l)
  }
}
