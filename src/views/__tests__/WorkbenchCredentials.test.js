// src/views/__tests__/WorkbenchCredentials.test.js
// 凭据页:列表渲染/创建载荷/智能解析回填/编辑三态(password 留空不出 value)。
import { test, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'

vi.mock('@/api/client', () => ({
  credentialsApi: {
    list: vi.fn().mockResolvedValue({ credentials: [
      { id: 'c1', name: 'gh', description: 'GitHub', tags: ['git'], exposeToAi: true,
        fields: [{ key: 'user', type: 'text' }, { key: 'token', type: 'password' }], updatedAt: 1 },
    ] }),
    get: vi.fn(), create: vi.fn().mockResolvedValue({ credential: { id: 'c2' } }),
    update: vi.fn().mockResolvedValue({ credential: { id: 'c1' } }),
    remove: vi.fn(), reveal: vi.fn(),
    parse: vi.fn().mockResolvedValue({ draft: { name: 'ssh-1', description: '', tags: ['a'],
      fields: [{ key: 'host', type: 'text', value: '10.0.0.1' }, { key: 'pwd', type: 'password', value: 'x' }] }, dropped: 0 }),
  },
}))
import { credentialsApi } from '@/api/client'
import WorkbenchCredentials from '@/views/WorkbenchCredentials.vue'

let mounted = null
function mountPage() {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = { role: 'admin' }
  mounted = mount(WorkbenchCredentials, { global: { plugins: [pinia, i18n, VueQueryPlugin] } })
  return mounted
}

// 用例后卸载:Teleport 到 body 的 Modal 不随断言消失,残留节点会污染后续用例的 body 查询
// (WorkbenchProjects.unbound.test.js 同款 afterEach unmount)。
afterEach(() => { mounted?.unmount(); mounted = null })

// Modal 内容 Teleport 到 body,w.find 看不见(WorkbenchProjects.unbound.test.js 同款:body 查询)。
const q = sel => new DOMWrapper(document.body.querySelector(sel))

test('列表渲染卡片:名称/AI 可见徽章/字段数', async () => {
  const w = mountPage()
  await flushPromises()
  expect(w.text()).toContain('gh')
  expect(w.text()).toContain('AI 可见')
})

test('创建:填名称+字段行 → create 收到字段袋载荷', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="cred-create-btn"]').trigger('click')
  await q('[data-testid="cred-name-input"]').setValue('new-cred')
  await q('[data-testid="cred-field-key-0"]').setValue('host')
  await q('[data-testid="cred-field-value-0"]').setValue('10.0.0.1')
  await q('[data-testid="cred-save-btn"]').trigger('click')
  await flushPromises()
  expect(credentialsApi.create).toHaveBeenCalledWith(expect.objectContaining({
    name: 'new-cred',
    fields: [expect.objectContaining({ key: 'host', type: 'password', value: '10.0.0.1' })],
  }))
})

test('智能粘贴:parse 回填表单', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="cred-create-btn"]').trigger('click')
  await q('[data-testid="cred-mode-smart"]').trigger('click')
  await q('[data-testid="cred-parse-text"]').setValue('任意文本')
  await q('[data-testid="cred-parse-btn"]').trigger('click')
  await flushPromises()
  expect(credentialsApi.parse).toHaveBeenCalledWith('任意文本')
  expect(q('[data-testid="cred-name-input"]').element.value).toBe('ssh-1')
  // 回填的字段名是 input value 而非文本节点,断言 field-key-0 的值(host)
  expect(q('[data-testid="cred-field-key-0"]').element.value).toBe('host')
})

test('编辑三态:password 值留空 → update 载荷该字段无 value 键', async () => {
  const w = mountPage()
  await flushPromises()
  credentialsApi.get.mockResolvedValue({ credential: { id: 'c1', name: 'gh', description: '', tags: [],
    exposeToAi: true, fields: [
      { key: 'user', type: 'text', value: 'liang' },
      { key: 'token', type: 'password', value: '*** (17 chars, #abcd1234)' }] } })
  await w.find('[data-testid="cred-edit-c1"]').trigger('click')
  await flushPromises()
  expect(q('[data-testid="cred-field-value-0"]').element.value).toBe('liang', 'text 回填现值')
  expect(q('[data-testid="cred-field-value-1"]').element.value).toBe('', 'password 恒空')
  await q('[data-testid="cred-save-btn"]').trigger('click')
  await flushPromises()
  const payload = credentialsApi.update.mock.calls[0][1]
  expect(payload.fields[1]).not.toHaveProperty('value', expect.anything())
  expect(payload.fields[1]).toEqual({ key: 'token', type: 'password' })
})
