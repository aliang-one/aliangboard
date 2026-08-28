// 关于面板契约:当前版本/最新版本渲染、dev 标、检测失败文案、立即检查调用、kubectl 命令含最新版本 tag;
// 2026-08-28 增:上次检查时间展示(B:query 错误态不永久「检测中…」;A:检查完成 toast 反馈;C:POST 失败不抛)。
// mock useAppVersion(面板自身不接 query),模拟状态经 hoisted state 切换;beforeEach 重置基线防跨 test 泄漏。
import { test, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const BASE = { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 }
const state = vi.hoisted(() => ({
  data: { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 },
  error: false,
  check: vi.fn(async () => {}),
  notify: vi.fn(),
}))
vi.mock('@/composables/useAppVersion', async () => {
  const { ref } = await import('vue')
  return { useAppVersion: () => ({ query: { data: ref(state.data), isError: ref(state.error) }, checkNow: state.check }) }
})
vi.mock('@/composables/useToast', () => ({ notify: state.notify }))

import SettingsAboutPanel from '@/components/settings/SettingsAboutPanel.vue'
import { i18n } from '@/i18n'

beforeEach(() => {
  state.data = { ...BASE }
  state.error = false
  state.check.mockReset().mockResolvedValue(undefined)
  state.notify.mockReset()
})

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
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  await w.find('button[data-test="check-now"]').trigger('click')
  expect(state.check).toHaveBeenCalledTimes(1)
})

test('kubectl 升级命令含最新版本镜像 tag(规范形=镜像 tag 形)', () => {
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('kubectl set image deployment/aliangboard aliangboard=ghcr.io/aliang-one/aliangboard:1.1.0 -n aliangboard')
})

test('B:query 本身报错(端点不可达)显示检测失败,不永久「检测中…」', () => {
  state.data = null
  state.error = true
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain(i18n.global.t('settings.about.checkFailed'))
  expect(w.text()).not.toContain(i18n.global.t('settings.about.checking'))
})

test('A1:已检查过显示「上次检查」时间(checkedAt 可见,检查不再零反馈)', () => {
  state.data = { ...BASE, checkedAt: Date.now() }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain(i18n.global.t('settings.about.lastChecked'))
})

test('A2:检查完成后按结果 toast——发现新版本', async () => {
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  await w.find('button[data-test="check-now"]').trigger('click')
  expect(state.notify).toHaveBeenCalledWith('success', `${i18n.global.t('settings.about.foundUpdate')} v1.1.0`)
})

test('A2:检查完成后按结果 toast——已是最新', async () => {
  state.data = { current: '1.1.0', latest: '1.1.0', hasUpdate: false, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  await w.find('button[data-test="check-now"]').trigger('click')
  expect(state.notify).toHaveBeenCalledWith('success', i18n.global.t('settings.about.upToDate'))
})

test('C:checkNow 抛错不产生未处理 rejection,toast 检测失败且按钮复位', async () => {
  state.check.mockRejectedValue(new Error('offline'))
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  await w.find('button[data-test="check-now"]').trigger('click')
  await Promise.resolve() // flush 微任务,若未 catch 此处已 unhandled rejection
  expect(state.notify).toHaveBeenCalledWith('error', i18n.global.t('settings.about.checkFailed'))
  expect(w.find('button[data-test="check-now"]').attributes('disabled')).toBeUndefined()
})
