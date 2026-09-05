// WbStage 舞台容器契约(spec §3):描边+回声线(舷板双钩边语言的直角版)+双 slot+高度链。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WbStage from '../WbStage.vue'

test('舞台容器:描边+回声线+双 slot 渲染,高度链类齐全', () => {
  const w = mount(WbStage, {
    slots: { titleBar: '<div data-test="tb">title</div>', default: '<div data-test="body">body</div>' },
  })
  const root = w.find('.wb-stage')
  expect(root.exists()).toBe(true)
  for (const cls of ['h-full', 'flex', 'flex-col', 'rounded-2xl', 'border', 'overflow-hidden', 'relative']) {
    expect(root.classes()).toContain(cls)
  }
  // 回声线:inset 3px、圆角 13px(16-3 同心数学)、pointer-events-none
  const echo = root.find('[data-test="wb-stage-echo"]')
  expect(echo.exists()).toBe(true)
  expect(echo.classes()).toContain('rounded-[13px]')
  expect(echo.classes()).toContain('pointer-events-none')
  expect(w.find('[data-test="tb"]').exists()).toBe(true)
  expect(w.find('[data-test="body"]').exists()).toBe(true)
})

test('titleBar 缺省时不渲染该段(default 照常)', () => {
  const w = mount(WbStage, { slots: { default: '<div data-test="body"/>' } })
  expect(w.find('[data-test="wb-stage-echo"]').exists()).toBe(true)
  expect(w.text()).not.toContain('title')
})
