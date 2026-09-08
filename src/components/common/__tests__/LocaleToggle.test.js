// LocaleToggle(独立页语言切换,round-2 2026-09-08):登录/选集群页无应用壳,
// 用户菜单不可达——独立页右上角需要自己的语言入口。语义与 UserMenu 分段按钮一致:
// preferences.setLanguage(本地 setLocale 即时生效 + 服务端同步,登录前 401 被 catch 本地仍生效)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { setLanguageMock, _lang } = vi.hoisted(() => ({ setLanguageMock: vi.fn(), _lang: { v: 'zh' } }))

vi.mock('@/stores/preferences', () => ({
  usePreferencesStore: () => ({ get language() { return _lang.v }, setLanguage: (...a) => setLanguageMock(...a) }),
}))

import LocaleToggle from '../LocaleToggle.vue'

function mountView() { return mount(LocaleToggle, { global: { plugins: [i18n] } }) }

beforeEach(() => {
  setLanguageMock.mockClear()
  _lang.v = 'zh'
})

test('渲染中/EN 分段,当前语言高亮(未设置时默认中文)', () => {
  const w = mountView()
  expect(w.find('[data-testid="locale-toggle-zh"]').text()).toBe('中文')
  expect(w.find('[data-testid="locale-toggle-en"]').text()).toBe('English')
  expect(w.find('[data-testid="locale-toggle-zh"]').classes()).toContain('bg-primary')
  expect(w.find('[data-testid="locale-toggle-en"]').classes()).not.toContain('bg-primary')
})

test('英文高亮随偏好切换(语言已设为 en)', () => {
  _lang.v = 'en'
  const w = mountView()
  expect(w.find('[data-testid="locale-toggle-en"]').classes()).toContain('bg-primary')
})

test('点击 English → preferences.setLanguage("en")', async () => {
  const w = mountView()
  await w.find('[data-testid="locale-toggle-en"]').trigger('click')
  expect(setLanguageMock).toHaveBeenCalledWith('en')
})
