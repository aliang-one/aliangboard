// 容器「完整编辑」弹窗:回显/实时校验(blur 后显错)/确认拦截/取消丢弃/自动命名预览。
// Modal Teleport 到 body → 一律 document.body 查询(与 CopyWorkloadDialog 测试同法);
// 事件交互用原生 dispatchEvent(happy-dom 支持,触发 v-model 的 input/blur)。
import { test, expect, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'
import { makeSubContainer } from '@/logic/subContainer'

const C = () => ({ name: '', image: '', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

let wrapper
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = '' })

function mountDialog(props = {}) {
  wrapper = mount(ContainerEditorDialog, {
    props: { modelValue: true, container: C(), kind: 'init', index: 0, otherNames: [], ...props },
    global: { plugins: [i18n], stubs: { EnvSourceField: true } },
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
  // 泛化后 draft = makeSubContainer 全字段与传入容器混入(同键覆盖)→ confirm payload 全字段
  expect(wrapper.emitted('confirm')[0][0]).toEqual({ ...makeSubContainer(), ...C(), name: 'my-init', image: 'busybox' })
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

test('全字段:env/ports/探针/原生开关在 draft 中编辑并随 confirm 完整发出', async () => {
  mountDialog({ container: { ...makeSubContainer(), name: 'sc', image: 'nginx' }, kind: 'sidecar', namespace: 'default' })
  // 展开 env 节并加一行
  $('ced-env-section').querySelector('button[data-testid="ced-env-toggle"]').click()
  await nextTick()
  $('ced-env-add').click()
  await nextTick()
  const key0 = $('ced-env-section').querySelector('[data-testid="ced-env-key-0"]')
  key0.value = 'K'; key0.dispatchEvent(new Event('input'))
  await nextTick()
  // 端口节加一行
  $('ced-ports-section').querySelector('button[data-testid="ced-ports-toggle"]').click()
  await nextTick()
  $('ced-ports-add').click()
  await nextTick()
  const port0 = $('ced-ports-section').querySelector('[data-testid="ced-port-0"]')
  port0.value = '9090'; port0.dispatchEvent(new Event('input'))
  await nextTick()
  // 原生开关(仅 sidecar 渲染)
  expect($('ced-native-toggle')).toBeTruthy()
  $('ced-native-toggle').click()
  await nextTick()
  $('ced-confirm-btn').click()
  const payload = wrapper.emitted('confirm')[0][0]
  expect(payload.envVars).toEqual([{ key: 'K', value: '' }])
  expect(payload.ports).toEqual([{ containerPort: 9090, protocol: 'TCP' }])   // v-model 对 type=number 自动数值化(buildSpec Number() 兼容)
  expect(payload.nativeSidecar).toBe(true)
})

test('init 容器不渲染原生 sidecar 开关', async () => {
  mountDialog({ container: { ...makeSubContainer(), image: 'nginx' }, kind: 'init' })
  expect($('ced-native-toggle')).toBeNull()
})

test('新校验:env 缺 key 残值行 blur 显错;探针 enabled 缺端口显错;确认禁用', async () => {
  mountDialog({ container: { ...makeSubContainer(), image: 'nginx' } })
  $('ced-env-section').querySelector('button[data-testid="ced-env-toggle"]').click()
  await nextTick()
  $('ced-env-add').click()
  await nextTick()
  const key0 = $('ced-env-section').querySelector('[data-testid="ced-env-key-0"]')
  const val0 = $('ced-env-section').querySelector('[data-testid="ced-env-val-0"]')
  val0.value = 'v'; val0.dispatchEvent(new Event('input'))   // 有 value 无 key → 非残行
  await nextTick()
  key0.dispatchEvent(new Event('blur'))
  await nextTick()
  expect($('ced-env-error').textContent).toContain(i18n.global.t('deploy.containerFv.envMissingKey', { idx: 1 }))
  $('ced-probes-section').querySelector('button[data-testid="ced-probes-toggle"]').click()
  await nextTick()
  $('ced-probe-enable-liveness').click()
  await nextTick()
  // makeSubContainer 探针默认 port=8080(合法)→ 清空端口再 blur 触发缺端口错误(brief 原文默认值下无错,最小适配保断言强度)
  const lp = $('ced-probes-section').querySelector('[data-testid="ced-liveness-port"]')
  lp.value = ''; lp.dispatchEvent(new Event('input')); lp.dispatchEvent(new Event('blur'))
  await nextTick()
  expect($('ced-liveness-error').textContent).toContain(i18n.global.t('deploy.containerFv.probePortRequired', { probe: 'liveness' }))
  expect($('ced-confirm-btn').disabled).toBe(true)
})
