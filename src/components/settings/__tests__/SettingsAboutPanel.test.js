// 关于面板契约:当前版本/最新版本渲染、dev 标、检测失败文案、立即检查调用、kubectl 命令含最新版本 tag。
// mock useAppVersion(面板自身不接 query),模拟状态经 hoisted state 切换。
import { test, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const state = vi.hoisted(() => ({
  data: { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 },
  check: vi.fn(async () => {}),
}))
vi.mock('@/composables/useAppVersion', async () => {
  const { ref } = await import('vue')
  return { useAppVersion: () => ({ query: { data: ref(state.data) }, checkNow: state.check }) }
})

import SettingsAboutPanel from '@/components/settings/SettingsAboutPanel.vue'
import { i18n } from '@/i18n'

beforeEach(() => { state.check.mockClear() })

test('渲染当前/最新版本(展示加 v 前缀)', () => {
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('v1.0.7')
  expect(w.text()).toContain('v1.1.0')
})

test('dev 构建显示 dev 与开发构建标,不显示失败', () => {
  state.data = { current: 'dev', latest: '1.1.0', hasUpdate: false, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('dev')
  expect(w.text()).toContain(i18n.global.t('settings.about.devBuild'))
})

test('latest=null 已加载:显示检测失败文案', () => {
  state.data = { current: '1.0.7', latest: null, hasUpdate: false, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain(i18n.global.t('settings.about.checkFailed'))
})

test('立即检查按钮调用 checkNow', async () => {
  state.data = { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  await w.find('button[data-test="check-now"]').trigger('click')
  expect(state.check).toHaveBeenCalledTimes(1)
})

test('kubectl 升级命令含最新版本镜像 tag(规范形=镜像 tag 形)', () => {
  state.data = { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('kubectl set image deployment/aliangboard aliangboard=ghcr.io/aliang-one/aliangboard:1.1.0 -n aliangboard')
})
