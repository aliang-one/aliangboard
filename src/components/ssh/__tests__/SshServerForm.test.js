// SshServerForm 契约:①必填校验(缺 name/host/username)②authMethod 切换显示密码/私钥
// ③exposeToAi=true 时审批策略下拉出现④编辑模式不回填凭据字段(placeholder 提示留空=保持)
// ⑤submit emit 完整 payload(凭据空串→字段缺失,语义「保持」)
import { test, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import SshServerForm from '../SshServerForm.vue'

const mountForm = (props = {}) => mount(SshServerForm, { props, global: { plugins: [i18n] } })

test('空表单 submit → 不 emit,展示必填错误', async () => {
  const w = mountForm()
  await w.find('form').trigger('submit')
  await flushPromises()
  expect(w.emitted('submit')).toBeFalsy()
  expect(w.html()).toContain('必填')
})

test('authMethod 切换:privateKey 显示私钥输入并隐藏密码输入', async () => {
  const w = mountForm()
  await w.find('[data-test="authMethod"]').setValue('privateKey')
  expect(w.find('[data-test="privateKey"]').exists()).toBe(true)
  expect(w.find('[data-test="password"]').exists()).toBe(false)
})

test('exposeToAi 开关联动审批策略选择器;submit payload 组装正确', async () => {
  const w = mountForm()
  await w.find('[data-test="name"]').setValue('web-1')
  await w.find('[data-test="host"]').setValue('10.0.0.5')
  await w.find('[data-test="username"]').setValue('ops')
  await w.find('[data-test="password"]').setValue('pw1')
  await w.find('[data-test="exposeToAi"]').trigger('click')   // ToggleSwitch:点击切换
  await w.find('[data-test="aiApprovalPolicy"]').setValue('readonly')
  await w.find('form').trigger('submit')
  await flushPromises()
  const payload = w.emitted('submit')[0][0]
  expect(payload).toMatchObject({ name: 'web-1', host: '10.0.0.5', username: 'ops', password: 'pw1', exposeToAi: true, aiApprovalPolicy: 'readonly' })
})

test('编辑模式(server 传入):不回填凭据值', () => {
  const w = mountForm({ server: { id: 'x', name: 'n', host: 'h', port: 22, username: 'u', authMethod: 'password', hasPassword: true } })
  expect(w.find('[data-test="password"]').element.value).toBe('')
})
