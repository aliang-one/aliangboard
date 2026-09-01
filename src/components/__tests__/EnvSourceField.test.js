import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EnvSourceField from '../common/EnvSourceField.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentCluster: 'c1', fetchConfigMaps: vi.fn(), fetchSecrets: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', async () => {
  const { ref } = await import('vue')
  const mk = items => ({ data: ref(items), isSuccess: ref(true) })
  return {
    useResourceList: ({ key }) => String(key).includes('secrets')
      ? mk([{ namespace: 'default', name: 'sec-a', data: { tok: 'x' } }])
      : mk([{ namespace: 'default', name: 'cm-a', data: { foo: '1', bar: '2' } }]),
  }
})

const mountField = (props = {}) => mount(EnvSourceField, {
  props: { kind: 'configmap', namespace: 'default', withKey: true, ...props },
})

test('② 用户键入资源名 → dataKey 被清空', async () => {
  const w = mountField({ name: 'cm-a', dataKey: 'foo' })
  await w.find('input').setValue('cm-b') // setValue 触发原生 input 事件
  expect(w.emitted('update:dataKey')?.at(-1)).toEqual([''])
})

test('② 程序化改 name(prop)→ dataKey 不清(复制 workload 回填场景)', async () => {
  const w = mountField({ name: 'cm-a', dataKey: 'foo' })
  await w.setProps({ name: 'cm-b' })
  expect(w.emitted('update:dataKey')).toBeUndefined()
})

test('② withKey=false(envFrom 场景)→ 键入不产生 update:dataKey', async () => {
  const w = mountField({ withKey: false, name: 'cm-a' })
  await w.find('input').setValue('cm-b')
  expect(w.emitted('update:dataKey')).toBeUndefined()
})

test('④ name 不在当前 ns 列表 → 显 nsMissing;匹配 → 不显', async () => {
  const miss = mountField({ name: 'ghost-cm', withKey: false })
  expect(miss.html()).toContain('envSource.nsMissing')
  const hit = mountField({ name: 'cm-a', withKey: false })
  expect(hit.html()).not.toContain('envSource.nsMissing')
})

// —— 2026-09-01 下拉遮挡/字号根治（PortSelect issue#4 配方推广）——

// 面板 Teleport 到 body,跨测试残留会互相污染(与 PortSelect.test.js 同款清理)
beforeEach(() => { document.body.innerHTML = '' })

const bodyPanel = () => document.body.querySelector('[data-testid="env-source-panel"]')
const openPanel = async (w, inputIdx = 0) => {
  await w.findAll('input')[inputIdx].trigger('focus')
  await nextTick()
  await nextTick()
}

test('⑤ 面板 Teleport 到 body + fixed + Z.popover(脱离 overflow 祖先裁切链)', async () => {
  const w = mountField()
  await openPanel(w)
  const panel = bodyPanel()
  expect(panel, '面板应传送至 document.body').toBeTruthy()
  expect(w.element.querySelector('[data-testid="env-source-panel"]')).toBeNull()
  expect(panel.style.position).toBe('fixed')
  expect(panel.style.zIndex).toBe('110')
})

test('⑤ 失焦后面板收起(body 中不残留)', async () => {
  const w = mountField()
  await openPanel(w)
  expect(bodyPanel()).toBeTruthy()
  await w.findAll('input')[0].trigger('blur')
  await nextTick()
  await nextTick()
  expect(bodyPanel()).toBeNull()
})

test('⑥ 选项显式字号:size=md→text-body-sm(修复继承放大)', async () => {
  const w = mountField({ size: 'md' })
  await openPanel(w)
  const opt = bodyPanel()?.querySelector('button')
  expect(opt, '面板应渲染候选项').toBeTruthy()
  expect(opt.className).toContain('text-body-sm')
})

test('⑥ 选项显式字号:默认 sm→text-xs(与输入框字号对齐)', async () => {
  const w = mountField()
  await openPanel(w)
  const opt = bodyPanel()?.querySelector('button')
  expect(opt).toBeTruthy()
  expect(opt.className).toContain('text-xs')
})

test('⑤ 面板宽度跟随触发输入框(matchTriggerWidth)', async () => {
  const w = mountField()
  await openPanel(w)
  const panel = bodyPanel()
  expect(panel.style.width).toBeTruthy()
})
