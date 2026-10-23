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

const captured = vi.hoisted(() => ({ metaSaves: [], imageUpdates: [], tplApplies: [], rollbacks: [], failNextMeta: false }))
const state = vi.hoisted(() => ({ workload: null, revisions: [], services: [], qc: null }))

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
  fetchServices: vi.fn(async () => state.services), fetchIngresses: vi.fn(async () => []), fetchEvents: vi.fn(async () => []),
  fetchPDBs: vi.fn(async () => []), fetchNetworkPolicies: vi.fn(async () => []),
  fetchReplicaSets: vi.fn(async () => []), fetchEndpoints: vi.fn(async () => []), fetchHPAs: vi.fn(async () => []),
  fetchWorkloadRevisions: vi.fn(async () => state.revisions),
  // 忠实模拟 live-watch 竞态:workload.value 就是 state.workload 本体(视图 .find 原对象),
  // updateWorkload 落库即改 state → await applyWorkloadTemplate 之后守卫读 live 值已见新镜像——
  // 复现「守卫在 await 后比对 live 值会误判没变」的真实时序(prevImage 回归锁的鉴别前提)
  updateWorkload: vi.fn((n, ns, updates) => {
    captured.imageUpdates.push(updates)
    if (updates?.image && state.workload) state.workload.image = updates.image
    return { ok: true }
  }),
  applyWorkloadTemplate: vi.fn((n, ns, tpl) => { captured.tplApplies.push(tpl); return { ok: true } }),
  updateWorkloadMeta: vi.fn((n, ns, payload) => {
    if (captured.failNextMeta) { captured.failNextMeta = false; return Promise.reject(new Error('mock meta patch 失败')) }
    captured.metaSaves.push(payload)
  }),
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
  // rev1._template 故意与当前模板不同面(team: legacy、无 version 键):鉴别回滚同步取的是
  // 「还原后的 _template」还是 stale 的 pre-rollback raw(取错会把 team: red 写回去)
  { rev: 1, image: OLD_IMAGE, current: false, replicas: 1, age: '10d', _template: { metadata: { labels: { app: 'demo-deploy', team: 'legacy' } }, spec: { containers: [{ name: 'main', image: OLD_IMAGE }] } } },
]

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  state.qc = qc
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
  captured.failNextMeta = false
  notify.mockClear()
  state.workload = makeWorkload({ [AUTO_KEY]: 'true' })
  state.revisions = JSON.parse(JSON.stringify(demoRevisions))
  state.services = []
  state.qc = null
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

test('关掉开关保存:开关注解进 removedAnnotations,版本保留手工输入值(非镜像同步值)', async () => {
  // 存量已同步形(version=1.25 于 metadata+模板一致)→ 关开关后手敲 v9-manual:保存应原样落 v9-manual
  state.workload = makeWorkload({ [AUTO_KEY]: 'true' })
  state.workload.labels[VKEY] = '1.25'
  state.workload.raw.spec.template.metadata.labels[VKEY] = '1.25'
  await openMetaModal()
  autoCheckbox().click(); await flushPromises() // 关掉 → 版本输入恢复可编辑
  const inp = versionInput()
  expect(inp.disabled).toBe(false)
  setInput(inp, 'v9-manual'); await flushPromises()
  await clickBody(i18n.global.t('workload.meta.save'))
  expect(captured.metaSaves).toHaveLength(1)
  const p = captured.metaSaves[0]
  expect(p.annotations[AUTO_KEY]).toBeUndefined()
  expect(p.removedAnnotations).toContain(AUTO_KEY)
  expect(p.labels[VKEY]).toBe('v9-manual')
  // 手工版本走 saveMeta 既有语义:业务 label 镜像进模板(与 syncHint 一致,变值触发一次滚动)
  expect(p.templateLabels[VKEY]).toBe('v9-manual')
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
  // 关键鉴别:模板面必须取自回滚刚还原的 _template(team: legacy),
  // 取 stale pre-rollback raw 会写回 team: red 并携带旧 labels 面引发二次滚动
  expect(p.templateLabels.team).toBe('legacy')
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

// --- 评审修复回归锁(2026-10-23 对抗评审:14 项确认 6 根因) ---

const LONG_TAG = `sha256-${'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'}` // 71 字符合法 Docker tag、非法 label 值

async function changeTagViaModal(tag) {
  const btn = document.body.querySelector(`button[title="${i18n.global.t('workload.rollout.changeTagTitle')}"]`)
  btn.click(); await flushPromises()
  const tagInput = [...document.body.querySelectorAll('input[placeholder="v3.5.1"]')].at(-1)
  setInput(tagInput, tag); await flushPromises()
  await clickBody(i18n.global.t('workload.imageTag.update'))
}

test('非法 label 值的超长 tag:镜像照常更新,同步明确拒写并提示(不 422 整包)', async () => {
  await mountDetail(); await flushPromises()
  await changeTagViaModal(LONG_TAG)
  expect(captured.imageUpdates[0]?.image).toBe(`ghcr.io/demo/app:${LONG_TAG}`)
  expect(captured.metaSaves, '非法 label 值不得进 patch(否则整包 422)').toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('不是合法的 K8s label 值'))
})

test('Service selector 钉住 version 标签(金丝雀):同步跳过模板层并点名,不静默拆 Endpoints', async () => {
  state.services = [{ name: 'pin-svc', namespace: 'default', type: 'ClusterIP', ports: '80:8080/TCP', selector: { app: 'demo-deploy', [VKEY]: 'vOld' }, portList: [] }]
  await mountDetail(); await flushPromises()
  await changeTagViaModal('1.26')
  expect(captured.imageUpdates[0]?.image).toBe('ghcr.io/demo/app:1.26')
  expect(captured.metaSaves, '模板 labels 变更会拆 pin-svc,必须整体跳过').toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('Service/pin-svc'))
})

test('同 tag 空转:不改镜像不触发同步(防无谓 bump last-edited)', async () => {
  await mountDetail(); await flushPromises()
  await changeTagViaModal('1.25') // 与当前镜像同 tag
  expect(captured.imageUpdates).toHaveLength(1)
  expect(captured.metaSaves).toHaveLength(0)
})

test('深编辑只改非镜像字段:不同步', async () => {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === i18n.global.t('common.edit')).trigger('click'); await flushPromises()
  // 副本数 1→2(镜像未动)→ 保存
  const repLabel = [...document.body.querySelectorAll('label')].find(l => l.textContent.includes(i18n.global.t('workload.edit.replicas')))
  if (repLabel) setInput(repLabel.parentElement.querySelector('input'), '2')
  await clickBody(i18n.global.t('workload.edit.save'))
  expect(captured.metaSaves).toHaveLength(0)
})

test('updateWorkloadMeta 拒绝:回退到 versionSyncFailed 提示,不炸交互流', async () => {
  captured.failNextMeta = true
  await mountDetail(); await flushPromises()
  await changeTagViaModal('1.26')
  expect(captured.metaSaves).toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('版本元数据同步失败'))
})

test('in-flight refetch 竞态:await 后 live 值已是新镜像,prevImage 快照仍判定「变了」→ 同步不丢', async () => {
  // mock store 已模拟真实时序:await applyWorkloadTemplate 期间 invalidate 重取,
  // workload.value.image 已刷新为 1.26。守卫若误比 live 值 → 误判「没变」→ 同步静默丢(评审根因 #4)
  await mountDetail(); await flushPromises()
  await changeTagViaModal('1.26')
  expect(captured.metaSaves).toHaveLength(1)
  expect(captured.metaSaves[0].labels[VKEY]).toBe('1.26')
})

test('saveMeta 非法 tag 门:开关开着且当前镜像 tag 非法 → 拦截保存并指路(不 422 整包)', async () => {
  state.workload = makeWorkload({ [AUTO_KEY]: 'true' })
  state.workload.image = `ghcr.io/demo/app:${LONG_TAG}`
  await openMetaModal()
  await clickBody(i18n.global.t('workload.meta.save'))
  expect(captured.metaSaves, '非法 label 值不得进 patch(整包必 422,业务元数据全存不上)').toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('不是合法的 K8s label 值'))
  // 弹窗保持打开(早退发生在任何 store 调用/状态变更之前,用户可关开关手工填)
  expect(autoCheckbox(), '拦截后弹窗应保持打开').toBeTruthy()
})
