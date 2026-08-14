// ClusterForm 共享表单:三种凭据方式显隐 + 必填校验(不 emit submit)+ submit/cancel 事件。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'
import ClusterForm from '../common/ClusterForm.vue'

function makeForm(over = {}) {
  return reactive({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false, ...over })
}
function mountForm(form, submitting = false) {
  return mount(ClusterForm, { props: { form, submitting }, global: { plugins: [i18n] } })
}
const submit = w => w.find('[data-testid="cluster-form-submit"]')
const cancel = w => w.find('[data-testid="cluster-form-cancel"]')

test('默认 kubeconfig 方式:名称+kubeconfig 输入渲染,token/basic 区块隐藏', () => {
  const w = mountForm(makeForm())
  expect(w.find('[data-testid="cluster-form-name"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-kubeconfig"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-apiserver"]').exists()).toBe(false)
  expect(w.find('[data-testid="cluster-form-token"]').exists()).toBe(false)
  expect(w.find('[data-testid="cluster-form-username"]').exists()).toBe(false)
})

test('切 token 方式:显示 apiServer+token;切 basic:显示 apiServer+username+password', async () => {
  const form = makeForm()
  const w = mountForm(form)
  await w.find('[data-testid="cluster-form-auth-token"]').trigger('click')
  expect(w.find('[data-testid="cluster-form-apiserver"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-token"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-kubeconfig"]').exists()).toBe(false)

  await w.find('[data-testid="cluster-form-auth-basic"]').trigger('click')
  expect(w.find('[data-testid="cluster-form-username"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-password"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-token"]').exists()).toBe(false)
})

test('空表单提交:不 emit submit,名称与 kubeconfig 内联错误', async () => {
  const form = makeForm()
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toBeUndefined()
  expect(w.find('[data-testid="cluster-form-error-name"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-error-kubeconfig"]').exists()).toBe(true)
})

test('token 方式缺 apiServer:显示 apiServer 错误,不 emit', async () => {
  const form = makeForm({ authMethod: 'token', token: 'eyX', name: 'demo' })
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toBeUndefined()
  expect(w.find('[data-testid="cluster-form-error-apiServer"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-error-token"]').exists()).toBe(false)
})

test('basic 方式缺 username:显示 username 错误,不 emit', async () => {
  const form = makeForm({ authMethod: 'basic', apiServer: 'https://10.0.0.1:6443', name: 'demo' })
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toBeUndefined()
  expect(w.find('[data-testid="cluster-form-error-username"]').exists()).toBe(true)
})

test('填齐(kubeconfig 方式)提交:emit submit 一次;cancel 按钮 emit cancel', async () => {
  const form = makeForm({ name: 'demo', kubeconfig: 'apiVersion: v1' })
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toHaveLength(1)
  await cancel(w).trigger('click')
  expect(w.emitted('cancel')).toHaveLength(1)
})

test('submitting=true 时提交按钮 disabled', () => {
  const w = mountForm(makeForm({ name: 'd', kubeconfig: 'x' }), true)
  expect(submit(w).attributes('disabled')).toBeDefined()
})

test('cancelLabel 覆盖默认按钮文案:传自定义文本时显示该文本,默认显示 zh「取消」', () => {
  const form = makeForm({ name: 'd', kubeconfig: 'x' })
  const w = mount(ClusterForm, { props: { form, cancelLabel: '自定义返回' }, global: { plugins: [i18n] } })
  expect(cancel(w).text()).toBe('自定义返回')
  const wDefault = mount(ClusterForm, { props: { form }, global: { plugins: [i18n] } })
  expect(cancel(wDefault).text()).toBe('取消')
})
