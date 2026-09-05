import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// === 集群默认不变式(spec §3.3):promote 先静默 sweep 旧默认,失败中止防双默认 ===
// 桩形状照抄 cluster.crud-factory.test.js 头部(api/client + queryClient + localStorage 垫片);
// 差异:新增 @/composables/useFetchers 可变桩(cluster.js/crud.js/rbac.js 直接 import,必须全覆盖导出名)。

const applyYaml = vi.fn(async () => ({ resources: [], applied: [], failed: [], total: 0 }))
const k8s = vi.fn(async () => ({}))
// crud.js 中止路径 notify('error', error)(spec §4 失败明细须可见),桩住并断言
const notify = vi.fn()
vi.mock('@/composables/useToast', () => ({ notify }))
vi.mock('@/api/client', () => ({
  api: { applyYaml, k8s },
  k8sStream: () => ({ abort() {} }),
  portForwardApi: { create: vi.fn(), remove: vi.fn(), list: vi.fn(async () => ({ forwards: [] })) },
  getSavedClusters: () => [],
  addSavedCluster: () => {},
  removeSavedCluster: () => {},
  setActiveToken: () => {},
  activeApiServer: () => '',
  getSessionToken: () => '',
}))

const getQueryData = vi.fn(() => [])
const invalidateQueries = vi.fn()
const setQueryData = vi.fn()
vi.mock('@/queryClient', () => ({
  queryClient: { getQueryData, invalidateQueries, setQueryData, clear: vi.fn() },
}))

// useFetchers 可变桩:复数读 state.xxx 返回列表(默认 []),单数返回对象(默认 null)。
// mock 工厂必须覆盖 cluster.js / cluster/crud.js / cluster/rbac.js import 的全部导出名。
const fetcherState = vi.hoisted(() => ({}))
vi.mock('@/composables/useFetchers', () => {
  const state = fetcherState
  const plural = key => (...a) => state[key] ? state[key](...a) : []
  const singular = key => (...a) => state[key] ? state[key](...a) : null
  const names = [
    'fetchNodes', 'fetchNode', 'fetchServices', 'fetchService', 'fetchConfigMaps', 'fetchConfigMap',
    'fetchSecrets', 'fetchSecret', 'fetchIngresses', 'fetchIngress', 'fetchNetworkPolicies', 'fetchNetworkPolicy',
    'fetchPDBs', 'fetchPDB', 'fetchLimitRanges', 'fetchLimitRange', 'fetchResourceQuotas', 'fetchResourceQuota',
    'fetchHPAs', 'fetchHPA', 'fetchEndpoints', 'fetchWorkloads', 'fetchPVCs', 'fetchPVs', 'fetchPV',
    'fetchStorageClasses', 'fetchStorageClass', 'fetchPVC', 'fetchRoles', 'fetchRoleBindings',
    'fetchClusterRoleBindings', 'fetchServiceAccounts', 'fetchRole', 'fetchRoleBinding', 'fetchServiceAccount',
    'fetchClusterRole', 'fetchClusterRoleBinding', 'fetchRuntimeClasses', 'fetchRuntimeClass',
    'fetchIngressClasses', 'fetchIngressClass', 'fetchPriorityClasses', 'fetchPriorityClass',
    'fetchNamespaces', 'fetchNamespace', 'fetchWorkloadRevisions', 'fetchReplicaSets',
  ]
  const mod = {}
  for (const n of names) {
    if (/Classes$|s$/.test(n) && !/Class$/.test(n)) mod[n] = plural(n)
    else mod[n] = singular(n)
  }
  return mod
})

// localStorage 垫片(store setup 顶层读 localStorage)
let _ls, _ss
beforeEach(() => {
  _ls = globalThis.localStorage
  _ss = globalThis.sessionStorage
  const mem = new Map()
  const shim = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
    clear: () => mem.clear(),
    key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  globalThis.localStorage = shim
  globalThis.sessionStorage = shim
  for (const k of Object.keys(fetcherState)) delete fetcherState[k]
  k8s.mockReset()
  k8s.mockImplementation(async () => ({}))
  applyYaml.mockClear()
  invalidateQueries.mockClear()
  notify.mockClear()
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

const { useClusterStore } = await import('@/stores/cluster')

const IC_KEY = 'ingressclass.kubernetes.io/is-default-class'

let store
beforeEach(() => {
  setActivePinia(createPinia())
  store = useClusterStore()
})

test('promoteIngressClassDefault: 先摘旧默认(sweep)再写新默认', async () => {
  fetcherState.fetchIngressClasses = async () => [
    { name: 'old', isDefault: true },
    { name: 'new' },
  ]
  k8s.mockClear()
  const r = await store.promoteIngressClassDefault('new')
  expect(r.ok).toBe(true)
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  expect(patches).toHaveLength(2)
  expect(patches[0][0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/old')
  expect(patches[0][1].body).toBe(JSON.stringify({ metadata: { annotations: { [IC_KEY]: null } } }))
  expect(patches[1][0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/new')
  expect(patches[1][1].body).toBe(JSON.stringify({ metadata: { annotations: { [IC_KEY]: 'true' } } }))
  expect(invalidateQueries).toHaveBeenCalled()
})

test('promoteIngressClassDefault: sweep 失败 → 中止,不写目标(防双默认)', async () => {
  fetcherState.fetchIngressClasses = async () => [{ name: 'old', isDefault: true }, { name: 'new' }]
  k8s.mockImplementation(async (path, opts) => {
    if (opts?.method === 'PATCH' && String(path).endsWith('/old')) throw new Error('403')
    return {}
  })
  k8s.mockClear()
  // 注意 mockImplementation 后仍可计数;先实现再 clear
  const r = await store.promoteIngressClassDefault('new')
  expect(r.ok).toBe(false)
  expect(notify).toHaveBeenCalledWith('error', r.error) // 中止必须 toast 失败明细(spec §4)
  const targetPatch = k8s.mock.calls.filter(c => String(c[0]).endsWith('/new') && c[1]?.method === 'PATCH')
  expect(targetPatch).toHaveLength(0)
})

test('demoteIngressClassDefault: 摘本类注解(null)', async () => {
  k8s.mockReset()
  k8s.mockImplementation(async () => ({}))
  const r = await store.demoteIngressClassDefault('old')
  expect(r.ok).toBe(true)
  const p = k8s.mock.calls.find(c => c[1]?.method === 'PATCH')
  expect(p[0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/old')
  expect(p[1].body).toBe(JSON.stringify({ metadata: { annotations: { [IC_KEY]: null } } }))
})

test('updateStorageClass(isDefault:true): sweep 其余 SC 默认(双 beta 键 null)', async () => {
  fetcherState.fetchStorageClasses = async () => [
    { name: 'sc-old', default: true },
    { name: 'sc-new' },
  ]
  fetcherState.fetchStorageClass = async () => ({ name: 'sc-new', default: false, labels: {}, annotations: {} })
  k8s.mockClear()
  const r = await store.updateStorageClass('sc-new', { isDefault: true })
  expect(r?.ok ?? true).toBeTruthy() // updateStorageClass 无显式 return(现状 undefined),不因返回形状失败
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  const sweepPatch = patches.find(c => String(c[0]).endsWith('/sc-old'))
  expect(sweepPatch).toBeTruthy()
  const body = JSON.parse(sweepPatch[1].body)
  expect(body.metadata.annotations['storageclass.kubernetes.io/is-default-class']).toBeNull()
  expect(body.metadata.annotations['storageclass.beta.kubernetes.io/is-default-class']).toBeNull()
})

// --- 列表拉取失败 = 无法判定现状默认,必须中止(spec §4):吞成空列表会漏 sweep → 双默认 ---

test('promoteIngressClassDefault: 列表拉取失败 → 中止,零 PATCH(不写目标)', async () => {
  fetcherState.fetchIngressClasses = async () => { throw new Error('boom') }
  const r = await store.promoteIngressClassDefault('new')
  expect(r.ok).toBe(false)
  expect(r.error).toBeTruthy()
  expect(notify).toHaveBeenCalledWith('error', r.error)
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  expect(patches).toHaveLength(0)
})

test('updateStorageClass(isDefault:true): SC 列表拉取失败 → 中止,零 PATCH', async () => {
  fetcherState.fetchStorageClasses = async () => { throw new Error('boom') }
  const r = await store.updateStorageClass('sc-new', { isDefault: true })
  expect(r.ok).toBe(false)
  expect(notify).toHaveBeenCalledWith('error', r.error)
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  expect(patches).toHaveLength(0)
})

test('promoteStorageClassDefault: SC 列表拉取失败 → 中止,零 PATCH', async () => {
  fetcherState.fetchStorageClasses = async () => { throw new Error('boom') }
  const r = await store.promoteStorageClassDefault('sc-new')
  expect(r.ok).toBe(false)
  expect(notify).toHaveBeenCalledWith('error', r.error)
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  expect(patches).toHaveLength(0)
})

// === 全参数结构化编辑(2026-09-05):updateIngressClassSpec 手术式 merge-patch ===
test('updateIngressClassSpec: fetch 单对象→手术 patch→PATCH→invalidate', async () => {
  fetcherState.fetchIngressClass = async () => ({
    name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: false,
    labels: { team: 'edge' }, annotations: { note: 'x' }, parameters: null,
  })
  const r = await store.updateIngressClassSpec('nginx', {
    controller: 'k8s.io/other', labels: { team: 'core' }, annotations: { note: 'x' },
  })
  expect(r.ok).toBe(true)
  const patch = k8s.mock.calls.find(c => c[1]?.method === 'PATCH')
  expect(patch[0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/nginx')
  expect(patch[1].headers['content-type']).toBe('application/merge-patch+json')
  expect(patch[1].body).toBe(JSON.stringify({ spec: { controller: 'k8s.io/other' }, metadata: { labels: { team: 'core' } } }))
  expect(invalidateQueries).toHaveBeenCalled()
})

test('updateIngressClassSpec: 无改动 → {ok:true} 且零 PATCH', async () => {
  fetcherState.fetchIngressClass = async () => ({ name: 'nginx', controller: 'c', isDefault: false, labels: {}, annotations: {}, parameters: null })
  const r = await store.updateIngressClassSpec('nginx', { controller: 'c' })
  expect(r.ok).toBe(true)
  expect(k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(0)
})

test('updateIngressClassSpec: fetch 失败 → {ok:false} 不写 + toast', async () => {
  fetcherState.fetchIngressClass = async () => { throw new Error('boom') }
  const r = await store.updateIngressClassSpec('nginx', { controller: 'x' })
  expect(r.ok).toBe(false)
  expect(notify).toHaveBeenCalledWith('error', r.error)
  expect(k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(0)
})
