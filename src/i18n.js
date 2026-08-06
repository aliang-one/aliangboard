import { createI18n } from 'vue-i18n'
import zh from './locales/zh.json'
import en from './locales/en.json'

const saved = localStorage.getItem('aliangboard.locale')

export const i18n = createI18n({
  legacy: false,
  locale: saved || 'zh',
  fallbackLocale: 'en',
  messages: { zh, en },
})

export function setLocale(l) {
  i18n.global.locale.value = l
  localStorage.setItem('aliangboard.locale', l)
}
