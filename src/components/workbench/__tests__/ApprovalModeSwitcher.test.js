// 审批三档模式切换器(2026-09-09 VSCode 风格):composer 工具栏入口。
// ask=每项确认(默认)/writes=写自动命令确认/auto=全部放行(须 ConfirmDialog 一次性确认)。
// 非 ask 档 trigger 常驻警示色(防忘记自己在放行档);SSH 服务器策略优先说明在菜单脚注。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ApprovalModeSwitcher from '@/components/workbench/ApprovalModeSwitcher.vue'
import { i18n } from '@/i18n'
import { usePreferencesStore } from '@/stores/preferences'
import { authApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  authApi: { savePreferences: vi.fn().mockResolvedValue({ prefs: {} }) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

function mountSwitcher() {
  return mount(ApprovalModeSwitcher, { global: { plugins: [i18n] }, attachTo: document.body })
}

// 选项按文件惯例 @mousedown.prevent 即选中(选中后菜单关闭,不可再补 click)
const clickOption = async (wrapper, mode) => {
  await wrapper.find(`[data-testid="approval-mode-option-${mode}"]`).trigger('mousedown')
}

test('默认 ask:trigger 显示当前档;菜单三项 + SSH 策略脚注', async () => {
  const w = mountSwitcher()
  await w.find('[data-testid="approval-mode-trigger"]').trigger('click')
  const menu = w.find('[data-testid="approval-mode-menu"]')
  expect(menu.exists()).toBe(true)
  for (const m of ['ask', 'writes', 'auto']) {
    expect(w.find(`[data-testid="approval-mode-option-${m}"]`).exists()).toBe(true)
  }
  // 键文案走 i18n(双语测试各自断,不硬编码)
  expect(menu.text()).toContain(i18n.global.t('workbench.chat.approvalMode.sshNote'))
  w.unmount()
})

test('选 writes:直接生效——store 更新 + PUT 携带该键,无确认弹窗', async () => {
  const w = mountSwitcher()
  await w.find('[data-testid="approval-mode-trigger"]').trigger('click')
  await clickOption(w, 'writes')
  const prefs = usePreferencesStore()
  expect(prefs.workbenchApprovalMode).toBe('writes')
  await vi.waitFor(() => expect(authApi.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ workbenchApprovalMode: 'writes' })))
  expect(document.querySelector('[data-testid="confirm-ok"]')).toBeNull()
  // 非 ask 档 trigger 常驻警示色:writes → tertiary(琥珀)
  expect(w.find('[data-testid="approval-mode-trigger"]').classes().some(c => c.includes('tertiary'))).toBe(true)
  w.unmount()
})

test('选 auto:弹一次性危险确认;取消不动,确认才生效(trigger error 色)', async () => {
  const w = mountSwitcher()
  await w.find('[data-testid="approval-mode-trigger"]').trigger('click')
  await clickOption(w, 'auto')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="confirm-ok"]')).not.toBeNull())
  // 取消:模式不动,弹窗关
  document.querySelector('[data-testid="confirm-cancel"]').click()
  await vi.waitFor(() => expect(document.querySelector('[data-testid="confirm-ok"]')).toBeNull())
  expect(usePreferencesStore().workbenchApprovalMode).toBeNull()
  // 再选 auto → 确认:生效 + error 警示色
  await w.find('[data-testid="approval-mode-trigger"]').trigger('click')
  await clickOption(w, 'auto')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="confirm-ok"]')).not.toBeNull())
  document.querySelector('[data-testid="confirm-ok"]').click()
  const prefs = usePreferencesStore()
  await vi.waitFor(() => expect(prefs.workbenchApprovalMode).toBe('auto'))
  await vi.waitFor(() => expect(authApi.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ workbenchApprovalMode: 'auto' })))
  expect(w.find('[data-testid="approval-mode-trigger"]').classes().some(c => c.includes('error'))).toBe(true)
  w.unmount()
})

test('auto 档下选回 ask:直接生效(降档无需确认)', async () => {
  const prefs = usePreferencesStore()
  prefs.setWorkbenchApprovalMode('auto')
  const w = mountSwitcher()
  await w.find('[data-testid="approval-mode-trigger"]').trigger('click')
  await clickOption(w, 'ask')
  expect(prefs.workbenchApprovalMode).toBe('ask')
  expect(document.querySelector('[data-testid="confirm-ok"]')).toBeNull()
  w.unmount()
})
