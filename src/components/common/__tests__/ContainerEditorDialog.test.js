// 容器「完整编辑」弹窗:回显/实时校验(blur 后显错)/确认拦截/取消丢弃/自动命名预览。
// Modal Teleport 到 body → 一律 document.body 查询(与 CopyWorkloadDialog 测试同法);
// 事件交互用原生 dispatchEvent(happy-dom 支持,触发 v-model 的 input/blur)。
import { test, expect, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'

const C = () => ({ name: '', image: '', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

let wrapper
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = '' })

function mountDialog(props = {}) {
  wrapper = mount(ContainerEditorDialog, {
    props: { modelValue: true, container: C(), kind: 'init', index: 0, otherNames: [], ...props },
    global: { plugins: [i18n] },
  })
  return wrapper
}
const $ = tid => document.body.querySelector(`[data-testid="${tid}"]`)
// happy-dom:dispatchEvent 同步触发监听,但 Vue 的 DOM 更新在微任务 → 每次交互后 await nextTick
const setInput = async (tid, v) => { const el = $(tid); el.value = v; el.dispatchEvent(new Event('input')); await nextTick() }
const blur = async tid => { $(tid).dispatchEvent(new Event('blur')); await nextTick() }

test('打开:回显字段;合法容器确认可点,点击 emit confirm(完整副本)+关闭', async () => {
  mountDialog({ container: { ...C(), name: 'my-init', image: 'busybox' } })
  expect($('ced-name-input').value).toBe('my-init')
  expect($('ced-image-input').value).toBe('busybox')
  expect($('ced-confirm-btn').disabled).toBe(false)
  $('ced-confirm-btn').click()
  expect(wrapper.emitted('confirm')[0][0]).toEqual({ ...C(), name: 'my-init', image: 'busybox' })
  expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
})

test('空镜像:确认禁用;blur 后显错;补填后错误消失且确认可点', async () => {
  mountDialog()
  expect($('ced-confirm-btn').disabled).toBe(true)
  expect($('ced-image-error')).toBeNull()          // blur 前不显错
  await blur('ced-image-input')
  expect($('ced-image-error').textContent).toContain(i18n.global.t('deploy.containerFv.imageRequired'))
  await setInput('ced-image-input', 'nginx')
  expect($('ced-image-error')).toBeNull()
  expect($('ced-confirm-btn').disabled).toBe(false)
})

test('name 非法/重复:blur 后各显对应错误', async () => {
  mountDialog({ otherNames: ['app'] })
  await setInput('ced-name-input', 'Bad_Name')
  await blur('ced-name-input')
  expect($('ced-name-error').textContent).toContain(i18n.global.t('deploy.containerFv.namePattern'))
  await setInput('ced-name-input', 'app')
  expect($('ced-name-error').textContent).toContain(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'app' }))
})

test('CPU 请求超上限:ResourceInput 改数后显错且确认禁用', async () => {
  mountDialog({ container: { ...C(), image: 'nginx' } })
  // ResourceInput 由 '100m' 初始化 → 数字框 100 + 单位 m;先切单位到 cores(''),数字 1 才 emit '1'
  const sel = $('ced-cpu-request').querySelector('select')
  sel.value = ''; sel.dispatchEvent(new Event('change')); await nextTick()
  const num = $('ced-cpu-request').querySelector('input')
  num.value = '1'; num.dispatchEvent(new Event('input'))
  $('ced-cpu-request').dispatchEvent(new Event('focusout')) // 触发 markTouched('cpu')
  await nextTick()
  expect($('ced-cpu-error').textContent).toContain(i18n.global.t('deploy.containerFv.cpuOverLimit', { req: '1', lim: '250m' }))
  expect($('ced-confirm-btn').disabled).toBe(true)
})

test('取消:emit update:modelValue(false) 且无 confirm', async () => {
  mountDialog({ container: { ...C(), image: 'nginx' } })
  $('ced-cancel-btn').click()
  expect(wrapper.emitted('confirm')).toBeUndefined()
  expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
})

test('自动命名预览:image 清洗基名;与现有名冲突显示去重注释', async () => {
  mountDialog({ container: { ...C(), image: 'ghcr.io/Org/My_App' } })
  expect($('ced-auto-name-preview').textContent).toContain('my-app')
  wrapper.unmount()                                    // 先卸载,避免两个 teleport 残留串查询
  mountDialog({ container: { ...C(), image: 'nginx' }, otherNames: ['nginx'] })
  expect($('ced-auto-name-preview').textContent).toContain(i18n.global.t('deploy.containerFv.autoNameDedupeNote', { name: 'nginx' }))
})
