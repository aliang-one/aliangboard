import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// === CRUD 工厂测试（全真实数据模型：纯远端 + Vue Query 缓存）===
// 断言：每类资源的 add/update/delete 调用正确的远端原语（api.applyYaml / api.k8s PATCH / api.k8s DELETE）
// + 传入正确的 path/YAML/patch body，并触发 invalidateQueries。
// 无 mock 模式假设（mock 已移除）。

// 桩 api/client：捕获 applyYaml (create/update) + k8s (patch/delete) 调用
const applyYaml = vi.fn(async () => ({ resources: [], applied: [], failed: [], total: 0 }))
const k8s = vi.fn(async () => ({}))
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

// 桩 queryClient：getQueryData 返回样当前对象；invalidateQueries 记录调用
const getQueryData = vi.fn(() => [])
const invalidateQueries = vi.fn()
const setQueryData = vi.fn()
vi.mock('@/queryClient', () => ({
  queryClient: { getQueryData, invalidateQueries, setQueryData, clear: vi.fn() },
}))

// localStorage 垫片（store setup 顶层读 localStorage）
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
  applyYaml.mockClear()
  k8s.mockClear()
  getQueryData.mockReset()
  invalidateQueries.mockClear()
  setQueryData.mockClear()
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

// 延迟 import（确保 vi.mock 已注册）
const { useClusterStore } = await import('@/stores/cluster')
const { hpaPatchFn } = await import('@/stores/cluster')

// --- helpers ---
function getStore() {
  setActivePinia(createPinia())
  return useClusterStore()
}

// 让 fromCache 返回一个样当前对象
function stubCache(plural, item) {
  getQueryData.mockImplementation(key => {
    if (Array.isArray(key) && key[2] === plural) return [item]
    return []
  })
}

// ========================================================================
// hpaPatchFn 纯函数测试（不依赖架构）
// ========================================================================

test('hpaPatchFn: 仅含 minReplicas/maxReplicas/metrics，不 prune behavior', () => {
  const before = { minReplicas: 1, maxReplicas: 5, cpuTarget: 80, memoryTarget: 80 }
  const updates = { minReplicas: 2, maxReplicas: 10 }
  const patch = hpaPatchFn('my-hpa', 'default', updates, before)
  expect(patch.spec.minReplicas).toBe(2)
  expect(patch.spec.maxReplicas).toBe(10)
  expect(patch.spec.metrics).toHaveLength(2)
  expect(patch.spec.metrics[0].resource.name).toBe('cpu')
  expect(patch.spec.metrics[0].resource.target.averageUtilization).toBe(80) // fallback to before
  // 不含 behavior / scaleTargetRef（不会被 prune）
  expect(patch.spec.behavior).toBeUndefined()
  expect(patch.spec.scaleTargetRef).toBeUndefined()
})

test('hpaPatchFn: updates 覆盖 before 的值', () => {
  const before = { minReplicas: 1, maxReplicas: 5, cpuTarget: 80, memoryTarget: 80 }
  const updates = { cpuTarget: 60, memoryTarget: 70 }
  const patch = hpaPatchFn('h', 'ns', updates, before)
  expect(patch.spec.metrics[0].resource.target.averageUtilization).toBe(60)
  expect(patch.spec.metrics[1].resource.target.averageUtilization).toBe(70)
})

// ========================================================================
// ConfigMap: 标准路径（add → applyYaml, update → applyYaml, delete → k8s DELETE）
// ========================================================================

test('addConfigMap: 调用 applyYaml 生成 YAML + invalidate configmaps', async () => {
  const store = getStore()
  await store.addConfigMap({ name: 'my-cm', namespace: 'default', data: { key: 'val' } })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const yaml = applyYaml.mock.calls[0][0]
  expect(yaml).toContain('kind: ConfigMap')
  expect(yaml).toContain('"my-cm"')
  expect(invalidateQueries).toHaveBeenCalled()
})

test('updateConfigMap: 从缓存取当前对象 → applyYaml 全量更新 + invalidate', async () => {
  const store = getStore()
  stubCache('configmaps', { name: 'my-cm', namespace: 'default', data: { key: 'old' } })
  await store.updateConfigMap('my-cm', 'default', { data: { key: 'new' } })
  expect(getQueryData).toHaveBeenCalledWith(['cluster', expect.any(String), 'configmaps'])
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const yaml = applyYaml.mock.calls[0][0]
  expect(yaml).toContain('kind: ConfigMap')
  expect(invalidateQueries).toHaveBeenCalled()
})

test('deleteConfigMap: 调用 k8s DELETE 正确 path + invalidate', async () => {
  const store = getStore()
  await store.deleteConfigMap('my-cm', 'default')
  expect(k8s).toHaveBeenCalledTimes(1)
  const [path, opts] = k8s.mock.calls[0]
  expect(path).toBe('/api/v1/namespaces/default/configmaps/my-cm')
  expect(opts.method).toBe('DELETE')
  expect(invalidateQueries).toHaveBeenCalled()
})

// ========================================================================
// Secret: beforeSave 编码 data（Critical 回归：编辑不丢 data）
// ========================================================================

test('addSecret: beforeSave 编码 data → YAML 含 stringData 明文（generateYAML 内部 decode）', async () => {
  const store = getStore()
  await store.addSecret({ name: 'my-sec', namespace: 'default', data: { password: 'plaintext' } })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const yaml = applyYaml.mock.calls[0][0]
  expect(yaml).toContain('kind: Secret')
  // generateYAML 内部 decodeBase64(beforeSave 编码后的值) → 还原为明文 stringData
  expect(yaml).toContain('password: plaintext')
})

test('updateSecret: beforeSave 对 updates.data 编码恰好一次 → stringData 是明文（issue#15 双重编码回归）', async () => {
  const store = getStore()
  // 缓存中的 data 已是编码态（真实场景：mapSecret 的输出）
  stubCache('secrets', { name: 'my-sec', namespace: 'default', data: { password: 'cGxhaW50ZXh0' } })
  await store.updateSecret('my-sec', 'default', { data: { password: 'newpass' } })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const yaml = applyYaml.mock.calls[0][0]
  expect(yaml).toContain('kind: Secret')
  // generateYAML secret 分支输出 stringData（非 data），证明走了 beforeSave → encodeSecretData → generateYAML decode 链路
  expect(yaml).toContain('stringData:')
  // 载荷必须是明文本身：apiserver 会再编码一次。'newpass' 被编码两次时此处会看到
  // 'bmV3cGFzcw=='（b64¹），集群里最终落 b64²，reveal/消费者拿到 b64¹ —— issue#15「保存后变加密值」
  expect(yaml).toContain('password: newpass')
})

test('updateSecret 仅改 labels/annotations: 缓存 data 不得被再编码 → stringData 仍是原明文', async () => {
  const store = getStore()
  stubCache('secrets', { name: 'my-sec', namespace: 'default', data: { password: 'cGxhaW50ZXh0' } })
  await store.updateSecret('my-sec', 'default', { annotations: { note: 'x' } })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const yaml = applyYaml.mock.calls[0][0]
  // 缓存 data（b64¹）被 yamlOf 再跑一次 beforeSave 时,这里会出现 'cGxhaW50ZXh0'（b64¹ 裸串）
  expect(yaml).toContain('password: plaintext')
  expect(yaml).toContain('note: x')
})

// ========================================================================
// Secret: 二进制(非 UTF-8)键 × 视图结构化编辑(2026-10-03 审计残留)
// NsSecretDetail.decodedData 用 decodeBase64,失败回退把仍是 b64 态的原串透传进 data;
// beforeSave 若无差别全量编码,b64² 恰是 ASCII → generateYAML 逐键路由误判「可解码」→
// stringData → apiserver 再编码 → 集群落 b64²(8f1af829 ② 只修了 labels-only 入参侧)。
// 不变式:值与集群现值相同 → 字节不动。
// ========================================================================

test('updateSecret 增键: 未触碰的二进制键原样留 data:, 不得二次编码', async () => {
  const store = getStore()
  const binB64 = btoa(String.fromCharCode(0xff, 0xfe, 0x01, 0x02)) // 非 UTF-8 → tryDecode 必失败
  stubCache('secrets', { name: 'my-sec', namespace: 'default', type: 'Opaque', data: { password: btoa('test123'), 'keystore.p12': binB64 } })
  // NsSecretDetail.addKey 的真实组合(NsSecretDetail.vue decodedData): 文本键解码为明文,
  // 二进制键 decodeBase64 失败回退原样透传 b64 + 用户新增文本键
  const data = { password: 'test123', 'keystore.p12': binB64, newkey: 'hello' }
  await store.updateSecret('my-sec', 'default', { data, keys: 3 })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const o = yamlLoad(applyYaml.mock.calls[0][0])
  // 文本键(含新增): 明文走 stringData, apiserver 编一次 → 集群单编码
  expect(o.stringData).toEqual({ password: 'test123', newkey: 'hello' })
  // 二进制键: 原样 b64 留 data:, apiserver 不再编码 → 集群值不变。
  // 双重编码时此处为 undefined(键被误路由进 stringData, 值是 b64¹ 串)
  expect(o.data).toEqual({ 'keystore.p12': binB64 })
})

test('updateSecret 删键: 未触碰的二进制键原样留 data:, 被删文本键消失', async () => {
  const store = getStore()
  const binB64 = btoa(String.fromCharCode(0xff, 0xfe, 0x01, 0x02))
  stubCache('secrets', { name: 'my-sec', namespace: 'default', type: 'Opaque', data: { password: btoa('test123'), 'keystore.p12': binB64 } })
  // NsSecretDetail.deleteKey 的真实组合: 删掉文本键 password, 二进制键原样透传
  await store.updateSecret('my-sec', 'default', { data: { 'keystore.p12': binB64 }, keys: 1 })
  const o = yamlLoad(applyYaml.mock.calls[0][0])
  expect(o.stringData).toEqual({}) // 无文本键 → 空块
  expect(o.data).toEqual({ 'keystore.p12': binB64 })
})

test('updateSecret: 新值敲成与集群编码值完全相同的串 → 视为未变更, 字节不动(编码态歧义裁决)', async () => {
  const store = getStore()
  stubCache('secrets', { name: 'my-sec', namespace: 'default', type: 'Opaque', data: { password: 'czNjcmV0' } }) // b64('s3cret')
  // 用户把新值敲成了当前编码值本身(例如从别处复制了 b64 串): 同值 ⇒ 集群字节不动
  await store.updateSecret('my-sec', 'default', { data: { password: 'czNjcmV0' }, keys: 1 })
  const o = yamlLoad(applyYaml.mock.calls[0][0])
  expect(o.stringData).toEqual({ password: 's3cret' }) // 原明文不变, 用户输入不生效(no-op)
  expect(o.data).toBeUndefined()
})

// ========================================================================
// HPA: patchFn 路径（remotePatch → k8s PATCH 定向 patch body）
// ========================================================================

test('updateHPA: patchFn 生成定向 patch → k8s PATCH + invalidate hpas', async () => {
  const store = getStore()
  stubCache('hpas', { name: 'my-hpa', namespace: 'default', minReplicas: 1, maxReplicas: 5, cpuTarget: 80, memoryTarget: 80 })
  await store.updateHPA('my-hpa', 'default', { minReplicas: 2 })
  expect(k8s).toHaveBeenCalledTimes(1)
  const [path, opts] = k8s.mock.calls[0]
  expect(path).toBe('/apis/autoscaling/v2/namespaces/default/horizontalpodautoscalers/my-hpa')
  expect(opts.method).toBe('PATCH')
  const body = JSON.parse(opts.body)
  expect(body.spec.minReplicas).toBe(2)
  expect(body.spec.maxReplicas).toBe(5) // from cache before
  expect(body.spec.behavior).toBeUndefined()
  expect(body.spec.metrics[0].resource.target.averageUtilization).toBe(80) // from cache before
  expect(invalidateQueries).toHaveBeenCalled()
})

// ========================================================================
// Service: sideEffects（namespace.services 计数）
// ========================================================================

test('addService: sideEffects.onAdd 不抛（namespaceList 为空时安全）', async () => {
  const store = getStore()
  await store.addService({ name: 'my-svc', namespace: 'default', type: 'ClusterIP' })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  expect(invalidateQueries).toHaveBeenCalled()
})

test('deleteService: k8s DELETE 正确 path + invalidate services', async () => {
  const store = getStore()
  await store.deleteService('my-svc', 'default')
  expect(k8s).toHaveBeenCalledTimes(1)
  const [path, opts] = k8s.mock.calls[0]
  expect(path).toBe('/api/v1/namespaces/default/services/my-svc')
  expect(opts.method).toBe('DELETE')
})

// ========================================================================
// PDB: genExtra 路径（generateExtraYAML）
// ========================================================================

test('addPDB: 使用 generateExtraYAML（非 generateYAML）', async () => {
  const store = getStore()
  await store.addPDB({ name: 'my-pdb', namespace: 'default', minAvailable: 2 })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  const yaml = applyYaml.mock.calls[0][0]
  expect(yaml).toContain('kind: PodDisruptionBudget')
})

// ========================================================================
// Ingress: 工厂 add/update/delete + updateIngressRules 手写
// ========================================================================

test('addIngress: applyYaml 生成 Ingress YAML', async () => {
  const store = getStore()
  await store.addIngress({ name: 'my-ing', namespace: 'default' })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  expect(applyYaml.mock.calls[0][0]).toContain('kind: Ingress')
})

// ========================================================================
// 集群级资源（namespaced:false）路径
// ========================================================================

test('addIngressClass: applyYaml → deleteIngressClass k8s DELETE 无 ns path', async () => {
  const store = getStore()
  await store.addIngressClass({ name: 'nginx' })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  await store.deleteIngressClass('nginx')
  expect(k8s).toHaveBeenCalledTimes(1)
  expect(k8s.mock.calls[0][0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/nginx')
  expect(k8s.mock.calls[0][1].method).toBe('DELETE')
})

test('deletePriorityClass: k8s DELETE 集群级 path', async () => {
  const store = getStore()
  await store.deletePriorityClass('high')
  expect(k8s).toHaveBeenCalledTimes(1)
  expect(k8s.mock.calls[0][0]).toBe('/apis/scheduling.k8s.io/v1/priorityclasses/high')
})

test('deleteClusterRoleBinding: k8s DELETE 集群级 path', async () => {
  const store = getStore()
  await store.deleteClusterRoleBinding('my-crb')
  expect(k8s).toHaveBeenCalledTimes(1)
  expect(k8s.mock.calls[0][0]).toBe('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/my-crb')
})

// ========================================================================
// 边界：update 缓存未命中 → fetch-first GET 兜底 → applyYaml 被调用
// ========================================================================

test('updateConfigMap 缓存未命中: fetch-first GET 兜底后 applyYaml 被调用', async () => {
  const store = getStore()
  // getQueryData 返回空数组 → fromCache 找不到 → 走 fetchConfigMap GET
  getQueryData.mockImplementation(() => [])
  // {ok} 契约(2026-08-17):update 失败吞异常但返回 {ok:false},调用方据此决定后续
  await expect(store.updateConfigMap('missing', 'default', { data: {} })).resolves.toEqual({ ok: true })
  expect(applyYaml).toHaveBeenCalledTimes(1)
  expect(invalidateQueries).toHaveBeenCalled()
})

// ========================================================================
// 验证所有工厂产品都在 store return 中（接线完整性）
// ========================================================================

test('store 暴露全部 17 资源的 add/update/delete', () => {
  const store = getStore()
  const resources = [
    'ConfigMap', 'Secret', 'PVC', 'Service', 'NetworkPolicy', 'HPA',
    'ResourceQuota', 'LimitRange', 'ServiceAccount', 'RoleBinding',
    'PDB', 'Ingress', 'IngressClass', 'RuntimeClass', 'PriorityClass',
    'ClusterRoleBinding',
  ]
  for (const res of resources) {
    expect(typeof store[`add${res}`], `add${res} 应为函数`).toBe('function')
    expect(typeof store[`update${res}`], `update${res} 应为函数`).toBe('function')
    expect(typeof store[`delete${res}`], `delete${res} 应为函数`).toBe('function')
  }
})
