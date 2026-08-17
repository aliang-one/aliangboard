// 相对时间(对话列表/悬浮微型列表共用);t = vue-i18n 翻译函数(workbench.detail.time* 键)。
export const relTime = (ts, t) => {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return t('workbench.detail.timeJustNow')
  if (s < 3600) return t('workbench.detail.timeMinAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('workbench.detail.timeHourAgo', { n: Math.floor(s / 3600) })
  return t('workbench.detail.timeDayAgo', { n: Math.floor(s / 86400) })
}
