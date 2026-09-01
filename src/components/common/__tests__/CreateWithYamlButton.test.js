import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const { applyYamlMock } = vi.hoisted(() => ({ applyYamlMock: vi.fn() }))
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: applyYamlMock }),
}))

import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

function mountBtn(props = {}) {
  return mount(CreateWithYamlButton, {
    props: { label: 'NEW', mainAction: () => {}, ...props },
    global: { plugins: [createPinia(), i18n] },
    attachTo: document.body,
  })
}
function menuItemTexts() {
  return [...document.body.querySelectorAll('[data-menu-item]')].map(el => {
    // SplitButton renders <span>{{ icon }}</span>{{ label }}
    // Extract just the label text, excluding icon span
    const iconSpan = el.querySelector('span.material-symbols-outlined')
    const text = el.textContent.trim()
    if (iconSpan) {
      const iconText = iconSpan.textContent.trim()
      return text.substring(iconText.length).trim()
    }
    return text
  })
}

test('主按钮触发 mainAction', async () => {
  const mainAction = vi.fn()
  const w = mountBtn({ mainAction })
  await w.findAll('button')[0].trigger('click')
  expect(mainAction).toHaveBeenCalledTimes(1)
  w.unmount()
})

test('YAML 项在最前、extraItems 随后(workload 视图现状顺序)', async () => {
  const w = mountBtn({ extraItems: [{ label: 'COPY', icon: 'content_copy', action: () => {} }] })
  await w.findAll('button')[1].trigger('click') // 箭头钮展开菜单
  const texts = menuItemTexts()
  expect(texts[0]).toContain(i18n.global.t('component.splitButton.createFromYaml'))
  expect(texts[1]).toBe('COPY')
  w.unmount()
})

test('YAML 项打开 dialog,模板随 yamlTemplate + namespace 填充', async () => {
  const w = mountBtn({ yamlTemplate: 'Service', namespace: 'demo' })
  await w.findAll('button')[1].trigger('click')
  // 菜单已 Teleport 到 body(SplitButton 2026-09-01),从 document 点击首项「从 YAML 创建」
  document.querySelector('[data-menu-item]').click()
  await flushPromises()
  expect(document.body.textContent).toContain('my-service')
  expect(document.body.textContent).toContain('demo')
  w.unmount()
})

test('mainOpensYaml=true:主按钮直开 dialog 且忽略 mainAction', async () => {
  const mainAction = vi.fn()
  const w = mountBtn({ mainAction, mainOpensYaml: true, yamlTemplate: 'RoleBinding', namespace: 'demo' })
  await w.findAll('button')[0].trigger('click')
  await flushPromises()
  expect(mainAction).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('my-rolebinding')
  w.unmount()
})

test('disabled 透传 SplitButton', async () => {
  const mainAction = vi.fn()
  const w = mountBtn({ mainAction, disabled: true })
  const [mainBtn] = w.findAll('button')
  expect(mainBtn.attributes('disabled')).toBeDefined()
  await mainBtn.trigger('click')
  expect(mainAction).not.toHaveBeenCalled()
  w.unmount()
})

test('applied 透传:dialog 创建成功后 emit applied', async () => {
  applyYamlMock.mockResolvedValue({ ok: true, kind: 'Service', name: 'my-service' })
  const w = mountBtn({ yamlTemplate: 'Service', namespace: 'demo' })
  await w.findAll('button')[1].trigger('click')
  document.querySelector('[data-menu-item]').click() // 菜单已 Teleport 到 body
  await flushPromises()
  const createBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('component.createFromYaml.create'))
  expect(createBtn).toBeTruthy()
  // DOM element: use native click, not wrapper.trigger()
  createBtn.click()
  await flushPromises()
  expect(applyYamlMock).toHaveBeenCalledTimes(1)
  expect(w.emitted('applied')).toHaveLength(1)
  w.unmount()
})
