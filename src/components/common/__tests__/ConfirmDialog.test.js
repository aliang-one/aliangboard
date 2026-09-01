// Teleport 弹层断言必须查 document.body(既往教训:查 wrapper 恒空)。
import { test, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

function mountDialog(props = {}) {
  return mount(ConfirmDialog, {
    props: { modelValue: true, title: '退出登录?', message: '确认退出当前账号?', ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

test('打开:标题/文案渲染于 document.body,含默认确认/取消钮', () => {
  const w = mountDialog()
  expect(document.body.textContent).toContain('退出登录?')
  expect(document.body.textContent).toContain('确认退出当前账号?')
  expect(document.body.querySelector('[data-testid="confirm-ok"]')).toBeTruthy()
  expect(document.body.querySelector('[data-testid="confirm-cancel"]')).toBeTruthy()
  w.unmount()
})

test('danger 态:确认钮 error 配色类', () => {
  const w = mountDialog({ danger: true })
  expect(document.body.querySelector('[data-testid="confirm-ok"]').className).toContain('bg-error')
  w.unmount()
})

test('点击确认:emit confirm 且不自动关窗(调用方成功后再关,失败可重试)', async () => {
  const w = mountDialog()
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await w.vm.$nextTick()
  expect(w.emitted('confirm')).toHaveLength(1)
  expect(w.emitted('update:modelValue')).toBeUndefined()
  w.unmount()
})

test('点击取消:emit cancel + update:modelValue=false', async () => {
  const w = mountDialog()
  document.body.querySelector('[data-testid="confirm-cancel"]').click()
  await w.vm.$nextTick()
  expect(w.emitted('cancel')).toHaveLength(1)
  expect(w.emitted('update:modelValue')[0]).toEqual([false])
  w.unmount()
})

test('loading 态:确认钮 disabled', () => {
  const w = mountDialog({ loading: true })
  expect(document.body.querySelector('[data-testid="confirm-ok"]').disabled).toBe(true)
  w.unmount()
})

test('手机档:ConfirmDialog 随 Modal 自动全屏(内部 max-w-md 被手机全屏覆盖)', async () => {
  mockViewport(true)
  const w = mountDialog({ title: '确认', message: '删?' })
  await w.vm.$nextTick()
  const dialog = document.querySelector('body .relative.w-full')
  expect(dialog).toBeTruthy()
  expect(dialog.className).toContain('max-w-none')
  expect(dialog.className).not.toContain('max-w-md')
  w.unmount(); document.body.innerHTML = ''
})
