// issue#16:NsWorkloadDetail 对 batch 家族的管理面复活。
// 钉住:① CronJob 手动触发按钮(08-03 详情页重构中丢失的回归)② restart/template 按钮对
// batch 缺席(语义无效,旧态点了静默失败)③ 编辑弹窗 schedule/suspend 真回填+真保存(旧态
// 假保存)④ Job 镜像输入禁用(spec.template 不可变)⑤ 删除失败留守不跳页。
// mock 策略照 NsWorkloadDetail.action-bar.test.js(cluster store 局部 mock + 真实 i18n/Vue Query)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const { cronJobApiTrigger, storeMocks, routeState, notifySpy } = vi.hoisted(() => ({
  cronJobApiTrigger: vi.fn(async () => ({ job: 'backup-manual-abc' })),
  storeMocks: {},
  routeState: { params: { name: 'backup', namespace: 'default', type: 'cronjob' }, query: {} },
  notifySpy: vi.fn(),
}))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})), trigger: cronJobApiTrigger },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => storeMocks }))
vi.mock('@/composables/useToast', () => ({ notify: notifySpy }))
const routerPush = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: routerPush }),
}))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

const cronWorkload = {
  name: 'backup', namespace: 'default', type: 'CronJob', status: 'Running', replicas: '0/0',
  image: 'busybox:1.36', schedule: '*/5 * * * *', suspend: false, labels: {}, annotations: {}, tier: 'default',
  raw: {
    metadata: { name: 'backup', namespace: 'default', labels: {}, annotations: {} },
    spec: {
      schedule: '*/5 * * * *', suspend: false,
      jobTemplate: { spec: { template: { metadata: { labels: { app: 'backup' } }, spec: { containers: [{ name: 'backup', image: 'busybox:1.36' }] } } } },
    },
    status: {},
  },
}
const jobWorkload = {
  name: 'migrate', namespace: 'default', type: 'Job', status: 'Succeeded', replicas: '1/1',
  image: 'migrate:v5', labels: {}, annotations: {}, tier: 'default',
  raw: {
    metadata: { name: 'migrate', namespace: 'default', labels: {}, annotations: {} },
    spec: { template: { metadata: { labels: { app: 'migrate' } }, spec: { containers: [{ name: 'migrate', image: 'migrate:v5' }] } } },
    status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
  },
}

function seedStore(wl, overrides = {}) {
  Object.assign(storeMocks, {
    watchStateOf: () => 'off',
    currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => ({ ok: true, allowed: true })),
    fetchWorkloads: vi.fn(async () => [wl]), fetchPods: vi.fn(async () => []),
    fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
    restartWorkload: vi.fn(async () => {}), scaleWorkload: vi.fn(async () => {}),
    updateWorkload: vi.fn(async () => {}), deleteWorkload: vi.fn(async () => true),
    invalidateAllClusterQueries: vi.fn(async () => {}),
    ...overrides,
  })
}

async function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
  await flushPromises()
  return w
}

beforeEach(() => {
  cronJobApiTrigger.mockClear(); routerPush.mockClear(); notifySpy.mockClear()
  routeState.params = { name: 'backup', namespace: 'default', type: 'cronjob' }
})

test('CronJob:手动触发按钮在场(08-03 重构回归),点击调 cronJobApi.trigger;restart/template 按钮缺席', async () => {
  seedStore(cronWorkload)
  const w = await mountDetail()
  const btns = w.findAll('button')
  const triggerBtn = btns.find(b => b.text().includes(i18n.global.t('workload.trigger')))
  expect(triggerBtn).toBeTruthy()
  expect(btns.find(b => b.text().includes(i18n.global.t('workload.restart')))).toBeUndefined()
  expect(btns.find(b => b.text().includes(i18n.global.t('workload.template')))).toBeUndefined()
  await triggerBtn.trigger('click')
  await flushPromises()
  expect(cronJobApiTrigger).toHaveBeenCalledWith({ namespace: 'default', name: 'backup' })
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob 编辑弹窗:schedule/suspend 回填,保存走 updateWorkload 真保存(非旧态静默 no-op)', async () => {
  seedStore(cronWorkload)
  const w = await mountDetail()
  const editBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('common.edit'))
  await editBtn.trigger('click')
  await flushPromises()
  const scheduleInput = [...document.body.querySelectorAll('input')].find(i => i.value === '*/5 * * * *')
  expect(scheduleInput).toBeTruthy()
  expect(document.body.textContent).toContain(i18n.global.t('workload.edit.suspend'))
  scheduleInput.value = '0 * * * *'
  scheduleInput.dispatchEvent(new Event('input'))
  const saveBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.edit.save'))
  await saveBtn.click()
  await flushPromises()
  expect(storeMocks.updateWorkload).toHaveBeenCalled()
  const updates = storeMocks.updateWorkload.mock.calls[0][2]
  expect(updates.schedule).toBe('0 * * * *')
  expect(updates.suspend).toBe(false)
  expect(updates.image).toBe('busybox:1.36')
  expect(updates.strategy).toBeUndefined()
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob 删除:deleteWorkload 返回 false 时留守详情页(不再无条件跳走)', async () => {
  seedStore(cronWorkload, { deleteWorkload: vi.fn(async () => false) })
  const w = await mountDetail()
  const delBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('workload.delete'))
  await delBtn.trigger('click')
  await flushPromises()
  const confirmBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.delete'))
  await confirmBtn.click()
  await flushPromises()
  expect(routerPush).not.toHaveBeenCalled()
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob 删除:成功才跳列表页', async () => {
  seedStore(cronWorkload, { deleteWorkload: vi.fn(async () => true) })
  const w = await mountDetail()
  const delBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('workload.delete'))
  await delBtn.trigger('click')
  await flushPromises()
  const confirmBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.delete'))
  await confirmBtn.click()
  await flushPromises()
  expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({ name: 'NsWorkloads' }))
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob 编辑弹窗:无 replicas 输入(isScalable=false)', async () => {
  seedStore(cronWorkload)
  const w = await mountDetail()
  const editBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('common.edit'))
  await editBtn.trigger('click')
  await flushPromises()
  expect(document.body.textContent).not.toContain(i18n.global.t('workload.edit.replicas'))
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob 编辑弹窗:suspend 勾选翻转路径(对抗审查 P3:绑定断裂时全套测试仍绿的假测试风险)', async () => {
  seedStore(cronWorkload)
  const w = await mountDetail()
  const editBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('common.edit'))
  await editBtn.trigger('click')
  await flushPromises()
  const suspendBox = [...document.body.querySelectorAll('input[type="checkbox"]')]
  expect(suspendBox.length).toBe(1)
  suspendBox[0].checked = true
  suspendBox[0].dispatchEvent(new Event('change'))
  await flushPromises()
  const saveBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.edit.save'))
  await saveBtn.click()
  await flushPromises()
  expect(storeMocks.updateWorkload).toHaveBeenCalled()
  expect(storeMocks.updateWorkload.mock.calls[0][2].suspend).toBe(true)
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob 编辑弹窗:schedule 清空时保存被拦(对抗审查 P3:静默回滚的假保存残余)', async () => {
  seedStore(cronWorkload)
  const w = await mountDetail()
  const editBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('common.edit'))
  await editBtn.trigger('click')
  await flushPromises()
  const scheduleInput = [...document.body.querySelectorAll('input')].find(i => i.value === '*/5 * * * *')
  scheduleInput.value = ''
  scheduleInput.dispatchEvent(new Event('input'))
  await flushPromises()
  const saveBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.edit.save'))
  await saveBtn.click()
  await flushPromises()
  expect(storeMocks.updateWorkload).not.toHaveBeenCalled()
  expect(notifySpy).toHaveBeenCalledWith('error', i18n.global.t('workload.notify.scheduleEmpty'))
  w.unmount(); document.body.innerHTML = ''
})

test('Job:镜像输入禁用+不可变提示(spec.template 创建后不可变,防 422)', async () => {
  routeState.params = { name: 'migrate', namespace: 'default', type: 'job' }
  seedStore(jobWorkload)
  const w = await mountDetail()
  const editBtn = w.findAll('button').find(b => b.text().trim() === i18n.global.t('common.edit'))
  await editBtn.trigger('click')
  await flushPromises()
  expect(document.body.textContent).toContain(i18n.global.t('workload.edit.jobImmutableHint'))
  const repoInput = [...document.body.querySelectorAll('input')].find(i => i.value === 'migrate')
  expect(repoInput).toBeTruthy()
  expect(repoInput.disabled).toBe(true)
  const saveBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('workload.edit.save'))
  await saveBtn.click()
  await flushPromises()
  const updates = storeMocks.updateWorkload.mock.calls[0][2]
  expect(updates.image).toBeUndefined()
  expect(updates.strategy).toBeUndefined()
  w.unmount(); document.body.innerHTML = ''
})

test('CronJob rollout 卡:暂停态显示「已暂停调度」(旧态恒显假进度 updating 0/1)', async () => {
  seedStore({ ...cronWorkload, raw: { ...cronWorkload.raw, spec: { ...cronWorkload.raw.spec, suspend: true } }, suspend: true })
  const w = await mountDetail()
  expect(w.text()).toContain(i18n.global.t('workload.rollout.suspended'))
  w.unmount(); document.body.innerHTML = ''
})

test('Job rollout 卡:完成态显示完成文案(旧态恒 0/1 Pending)', async () => {
  routeState.params = { name: 'migrate', namespace: 'default', type: 'job' }
  seedStore(jobWorkload)
  const w = await mountDetail()
  expect(w.text()).toContain(i18n.global.t('workload.rollout.jobComplete', { done: 1, total: 1 }))
  w.unmount(); document.body.innerHTML = ''
})
