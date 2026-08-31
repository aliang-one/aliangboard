// 更新横幅契约:有更新未关→渲染;关闭→localStorage 记规范形且消失;
// latest=null / 已关同版本 → 不渲染。(props 驱动,不依赖 query,AppLayout 接线由挂载回归覆盖)
import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdateBanner from '@/components/layout/UpdateBanner.vue'
import { i18n } from '@/i18n'

const KEY = 'ab.updateBannerDismissed'

beforeEach(() => localStorage.removeItem(KEY))

test('有新版本未关闭:渲染,展示 v 前缀版本号与 tags 链接', () => {
  const w = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('v1.1.0')
  expect(w.find('a[href="https://github.com/aliang-one/aliangboard/tags"]').exists()).toBe(true)
})

test('点击关闭:localStorage 记规范形,横幅消失', async () => {
  const w = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  await w.find('button[aria-label]').trigger('click')
  expect(localStorage.getItem(KEY)).toBe('1.1.0')
  expect(w.find('a').exists()).toBe(false)
})

test('latest=null(检测失败/无更新):不渲染', () => {
  const w = mount(UpdateBanner, { props: { latest: null }, global: { plugins: [i18n] } })
  expect(w.find('a').exists()).toBe(false)
})

test('同版本已关闭过:不渲染;更更新版本再弹', async () => {
  localStorage.setItem(KEY, '1.1.0')
  const w = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  expect(w.find('a').exists()).toBe(false)
  await w.setProps({ latest: '1.2.0' })
  expect(w.find('a').exists()).toBe(true)
})

test('横幅文本可截断不撑爆窄屏', () => {
  const wrapper = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  expect(wrapper.html()).toContain('min-w-0')
  expect(wrapper.html()).toContain('truncate')
})
