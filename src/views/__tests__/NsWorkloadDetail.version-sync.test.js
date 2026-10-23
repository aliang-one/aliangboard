// 版本元数据「跟随镜像 tag 自动更新」交互测试(2026-10-23)。
// 开关注解 aliangboard.io/version-auto=true 后锁六件事:
// ①meta 弹窗打开开关保存 → version label 立即对齐当前镜像 tag + 开关注解落库
// ②开关已开:再次打开弹窗勾选态保持、版本输入禁用且显示同步值
// ③开关关掉保存 → 开关注解进 removedAnnotations(merge-patch 删除),版本保留手工值
// ④开关注解不进自定义注解行(否则每次保存元数据会被静默误删/误改)
// ⑤改版本弹窗换 tag → updateWorkloadMeta 同步新 tag(metadata + 模板两处)
// ⑥深编辑表单改镜像 tag / 回滚到旧版本 → 同步目标镜像 tag;开关关时同步全程哑火。
// mock 策略与 NsWorkloadDetail.selector-guard 一致(mock @/api/client 与 @/stores/cluster,
// 真实 i18n + Vue Query;Modal teleport 到 body,交互走 document.body)。
import { test, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ metaSaves: [], imageUpdates: [], tplApplies: [], rollbacks: [] }))
const state = vi.hoisted(() => ({ workload: null, revisions: [] }))

import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
vi.mock('@/composables/useToast', async (importOriginal) => ({ ...(await importOriginal()), notify: vi.fn() }))
import { notify } from '@/composables/useToast'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [state.workload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  fetchServices: vi.fn(async () => []), fetchIngresses: vi.fn(async () => []), fetchEvents: vi.fn(async () => []),
  fetchPDBs: vi.fn(async () => []), fetchNetworkPolicies: vi.fn(async () => []),
  fetchReplicaSets: vi.fn(async () => []), fetchEndpoints: vi.fn(async () => []), fetchHPAs: vi.fn(async () => []),
  fetchWorkloadRevisions: vi.fn(async () => state.revisions),
  updateWorkload: vi.fn((n, ns, updates) => { captured.imageUpdates.push(updates); return { ok: true } }),
  applyWorkloadTemplate: vi.fn((n, ns, tpl) => { captured.tplApplies.push(tpl); return { ok: true } }),
  updateWorkloadMeta: vi.fn((n, ns, payload) => { captured.metaSaves.push(payload) }),
  rollbackWorkload: vi.fn((n, ns, rev) => { captured.rollbacks.push(rev); return { ok: true } }),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

const VKEY = 'aliangboard.io/version'
const AUTO_KEY = 'aliangboard.io/version-auto'
const IMAGE = 'ghcr.io/demo/app:1.25'
const OLD_IMAGE = 'ghcr.io/demo/app:1.24'

// 模板 version label 故意放陈旧值 vOld:开启开关保存应把 metadata + 模板一并对齐(线上病灶形)
function makeWorkload(annotations = {}) {
  return {
    name: 'demo-deploy', namespace: 'default', type: 'Deployment', image: IMAGE,
    labels: { app: 'demo-deploy' }, annotations: { ...annotations },
    raw: {
      metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo-deploy' }, annotations: {} },
      spec: {
        replicas: 1, selector: { matchLabels: { app: 'demo-deploy' } },
        template: { metadata: { labels: { app: 'demo-deploy', [VKEY]: 'vOld', team: 'red' } }, spec: { containers: [{ name: 'main', image: IMAGE, ports: [{ containerPort: 8080, protocol: 'TCP' }] }] } },
      },
    },
  }
}
const demoRevisions = [
  { rev: 2, image: IMAGE, current: true, replicas: 1, age: '5d' },
  { rev: 1, image: OLD_IMAGE, current: false, replicas: 1, age: '10d' },
]

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { attachTo: document.body, global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}
const bodyBtns = text => [...document.body.querySelectorAll('button')].filter(b => b.textContent.trim() === text)
const setInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')) }
async function clickBody(text) {
  const el = bodyBtns(text).at(-1)
  expect(el, `body 内应有「${text}」按钮`).toBeTruthy()
  el.click(); await flushPromises()
}
async function openMetaModal() {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === i18n.global.t('workload.metadata')).trigger('click')
  await flushPromises()
  return w
}
// meta 弹窗内「跟随镜像 tag 自动更新」开关:定位含开关文案的 label 里的 checkbox
function autoCheckbox() {
  const label = [...document.body.querySelectorAll('label')].find(l => l.textContent.includes(i18n.global.t('workload.meta.versionAuto')))
  expect(label, 'meta 弹窗应有「跟随镜像 tag 自动更新」开关').toBeTruthy()
  const cb = label.querySelector('input[type="checkbox"]')
  expect(cb, '开关应为 checkbox').toBeTruthy()
  return cb
}
// meta 弹窗内「版本 version」输入框
function versionInput() {
  const label = [...document.body.querySelectorAll('label')].find(l => l.textContent.includes(i18n.global.t('workload.meta.versionLabel')))
  expect(label, 'meta 弹窗应有版本输入').toBeTruthy()
  return label.parentElement.querySelector('input')
}

beforeEach(() => {
  document.body.innerHTML = ''
  captured.metaSaves.length = 0; captured.imageUpdates.length = 0
  captured.tplApplies.length = 0; captured.rollbacks.length = 0
  notify.mockClear()
  state.workload = makeWorkload({ [AUTO_KEY]: 'true' })
  state.revisions = JSON.parse(JSON.stringify(demoRevisions))
  i18n.global.locale.value = 'zh'
})

test('开启开关保存:version 立即对齐当前镜像 tag(metadata+模板)+ 开关注解落库', async () => {
  state.workload = makeWorkload() // 无开关注解:从关到开
  await openMetaModal()
  autoCheckbox().click(); await flushPromises()
  await clickBody(i18n.global.t('workload.meta.save'))
  expect(captured.metaSaves).toHaveLength(1)
  const p = captured.metaSaves[0]
  expect(p.labels[VKEY]).toBe('1.25')
  expect(p.annotations[AUTO_KEY]).toBe('true')
  expect(p.templateLabels[VKEY], '模板 version 也应对齐(根治两处各烂各的)').toBe('1.25')
})

test('开关已开:重开弹窗勾选态保持,版本输入禁用且显示同步值(非存量脏值)', async () => {
  await openMetaModal()
  expect(autoCheckbox().checked).toBe(true)
  const inp = versionInput()
  expect(inp.disabled).toBe(true)
  expect(inp.value).toBe('1.25')
})

test('关掉开关保存:开关注解进 removedAnnotations,版本保留手工值', async () => {
  state.workload = makeWorkload({ [AUTO_KEY]: 'true' })
  state.workload.labels[VKEY] = '1.25' // 与模板一致的已同步形
  await openMetaModal()
  autoCheckbox().click(); await flushPromises() // 关掉
  await clickBody(i18n.global.t('workload.meta.save'))
  expect(captured.metaSaves).toHaveLength(1)
  const p = captured.metaSaves[0]
  expect(p.annotations[AUTO_KEY]).toBeUndefined()
  expect(p.removedAnnotations).toContain(AUTO_KEY)
  expect(p.labels[VKEY]).toBe('1.25')
})

test('开关注解不进自定义注解行(防止每次保存元数据被静默误删/误改)', async () => {
  await openMetaModal()
  const keyVals = [...document.body.querySelectorAll('input[placeholder="key"]')].map(i => i.value)
  expect(keyVals).not.toContain(AUTO_KEY)
})

test('改版本弹窗换 tag:开关开着 → updateWorkloadMeta 同步新 tag', async () => {
  const w = mountDetail(); await flushPromises()
  const btn = document.body.querySelector(`button[title="${i18n.global.t('workload.rollout.changeTagTitle')}"]`)
  expect(btn, '头部应有「改版本」按钮').toBeTruthy()
  btn.click(); await flushPromises()
  const tagInput = [...document.body.querySelectorAll('input[placeholder="v3.5.1"]')].at(-1)
  expect(tagInput, '改版本弹窗应有新 tag 输入').toBeTruthy()
  setInput(tagInput, '1.26'); await flushPromises()
  await clickBody(i18n.global.t('workload.imageTag.update'))
  expect(captured.imageUpdates[0]?.image).toBe('ghcr.io/demo/app:1.26')
  expect(captured.metaSaves).toHaveLength(1)
  const p = captured.metaSaves[0]
  expect(p.labels[VKEY]).toBe('1.26')
  expect(p.templateLabels[VKEY]).toBe('1.26')
  // 模板其余键不得被同步误伤
  expect(p.templateLabels.app).toBe('demo-deploy')
  expect(p.templateLabels.team).toBe('red')
})

test('深编辑表单改镜像 tag:开关开着 → 保存后同步新 tag', async () => {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === i18n.global.t('common.edit')).trigger('click'); await flushPromises()
  const label = [...document.body.querySelectorAll('label')].find(l => l.textContent.includes(i18n.global.t('workload.edit.imageTag')))
  expect(label, '编辑弹窗应有版本 Tag 输入').toBeTruthy()
  setInput(label.parentElement.querySelector('input'), '1.26'); await flushPromises()
  await clickBody(i18n.global.t('workload.edit.save'))
  expect(captured.metaSaves).toHaveLength(1)
  expect(captured.metaSaves[0].labels[VKEY]).toBe('1.26')
})

test('回滚到旧版本:开关开着 → 同步目标版本镜像的 tag', async () => {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.revisions')).trigger('click'); await flushPromises()
  // 版本 tab 表格行内「回滚」(此刻确认弹窗未开,唯一);确认弹窗按钮同为「回滚」→ clickBody 取最后一个
  await clickBody(i18n.global.t('workload.revisionsTab.rollback'))
  await clickBody(i18n.global.t('workload.modals.rollbackTitle'))
  expect(captured.rollbacks).toEqual([1])
  expect(captured.metaSaves).toHaveLength(1)
  const p = captured.metaSaves[0]
  expect(p.labels[VKEY]).toBe('1.24')
  expect(p.templateLabels[VKEY]).toBe('1.24')
})

test('开关没开:改镜像全程不触发 updateWorkloadMeta(同步哑火)', async () => {
  state.workload = makeWorkload() // 无开关注解
  const w = mountDetail(); await flushPromises()
  const btn = document.body.querySelector(`button[title="${i18n.global.t('workload.rollout.changeTagTitle')}"]`)
  btn.click(); await flushPromises()
  const tagInput = [...document.body.querySelectorAll('input[placeholder="v3.5.1"]')].at(-1)
  setInput(tagInput, '1.26'); await flushPromises()
  await clickBody(i18n.global.t('workload.imageTag.update'))
  expect(captured.imageUpdates[0]?.image).toBe('ghcr.io/demo/app:1.26')
  expect(captured.metaSaves).toHaveLength(0)
})
