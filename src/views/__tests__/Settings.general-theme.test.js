// Settings 挂载用例:非 admin(auth.user=null)时 onMounted 不发任何请求,general tab 直接可测
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import Settings from '@/views/Settings.vue'
import { usePreferencesStore } from '@/stores/preferences'

test('general tab:主题三态行,点击深色即时生效,未设置时高亮 auto', async () => {
  setActivePinia(createPinia())
  const w = mount(Settings, { global: { plugins: [i18n] } })
  for (const v of ['light', 'dark', 'auto']) {
    expect(w.find(`[data-testid="settings-theme-${v}"]`).exists()).toBe(true)
  }
  expect(w.find('[data-testid="settings-theme-auto"]').classes()).toContain('bg-primary')
  await w.find('[data-testid="settings-theme-dark"]').trigger('click')
  expect(usePreferencesStore().theme).toBe('dark')
  expect(w.find('[data-testid="settings-theme-dark"]').classes()).toContain('bg-primary')
  w.unmount()
})
