# Workload 族数据层(缓存永驻+载荷瘦身+watch 增量)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** workload 族(workloads/services/ingresses/pods/events)数据层改为「缓存永驻 + 瘦载荷 list + watch 增量推送」,消除 NsLayers 重访空白并把静止集群请求降到 ~0。

**Architecture:** Vue Query canonical key 保持 `['cluster', cid, resource]` 单源;新增 `useClusterWatch` 控制器(退避重连/410 relist/降级轮询状态机)把 7 条 K8s watch 流增量 merge 进缓存;`fetchWorkloads` 拆掉 ReplicaSet 全史(回滚历史独立 fetcher);网关 list 响应剥 managedFields/last-applied-configuration。

**Tech Stack:** Vue 3 + @tanstack/vue-query(已有)、纯 JS 无新依赖、vitest(前端单测)、node --test(网关)。

**规格:** `docs/superpowers/specs/2026-08-26-workload-datalayer-cache-watch-design.md`

## Global Constraints

- 不新增任何 npm 依赖(CLAUDE.md 依赖政策)。
- `refetchInterval` 必须直传 ref/computed,不得传解包值(既有约定,见 NsWorkloadDetail.vue:76 注释)。
- vitest 模块级 mock 必须配 reset(`beforeEach` 里重置),防跨用例串扰(既有教训)。
- i18n:新增文案 zh.json/en.json 双语同步;消息值含 HTML 须 v-html(本次不涉及);`@` 须转义(本次不涉及)。
- 提交:作者 aliangone(repo config 已设),**禁止 Claude 尾注**;每任务一提交。
- 测试命令:前端单文件 `npx vitest run <path>`;网关单文件 `node --test <path>`;全量 `npm test` + `npm run typecheck`。
- `.vue` 文件改动后最终以 `npm run build` 验证(typecheck 不覆盖 .vue)。
- 工作分支:`feat-workload-datalayer-watch`(已建,规格已在其上)。

---

### Task 1: 网关 list 响应剥冗余字段

**Files:**
- Create: `server/k8s-slim.mjs`
- Test: `server/k8s-list-slim.test.mjs`
- Modify: `server/index.mjs`(K8s 代理非流式分支,~1936-1941 行 `return sendJson(res, result.status, result.body ?? {})` 处)

**Interfaces:**
- Produces: `slimListBody(body)`(server/k8s-slim.mjs 导出,后续无消费者,属网关终端行为)

- [ ] **Step 1: 写失败测试**

`server/k8s-list-slim.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slimListBody } from './k8s-slim.mjs'

const item = () => ({
  metadata: {
    name: 'nginx', namespace: 'default',
    managedFields: [{ manager: 'kubectl', fieldsV1: {} }],
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"big":"blob"}', 'app.kubernetes.io/name': 'nginx' },
  },
  spec: { replicas: 2 },
  status: { readyReplicas: 2 },
})

test('list body: 剥 managedFields 与 last-applied-configuration,保留 spec/status/其余注解', () => {
  const body = { metadata: { resourceVersion: '100' }, items: [item()] }
  const out = slimListBody(body)
  const m = out.items[0].metadata
  assert.equal(m.managedFields, undefined)
  assert.equal(m.annotations['kubectl.kubernetes.io/last-applied-configuration'], undefined)
  assert.equal(m.annotations['app.kubernetes.io/name'], 'nginx')
  assert.deepEqual(out.items[0].spec, { replicas: 2 })
  assert.deepEqual(out.items[0].status, { readyReplicas: 2 })
  assert.equal(out.metadata.resourceVersion, '100')  // RV 必须保留(watch 续接依赖)
})

test('非 list body(无 items/单对象)原样返回;annotations 缺失不炸', () => {
  const single = { metadata: { name: 'x', managedFields: [{}] }, spec: {} }
  assert.equal(slimListBody(single), single)
  assert.equal(slimListBody(null), null)
  const noAnn = slimListBody({ items: [{ metadata: { name: 'y' }, spec: {} }] })
  assert.equal(noAnn.items[0].metadata.name, 'y')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/k8s-list-slim.test.mjs`
Expected: FAIL(`Cannot find module './k8s-slim.mjs'`)

- [ ] **Step 3: 实现**

`server/k8s-slim.mjs`:

```js
// K8s list 响应瘦身:剥 metadata.managedFields 与 last-applied-configuration 注解。
// 两者对前端均为纯冗余(所有消费方都在删 managedFields;last-applied 无读取方),
// 大集群下可占 list 响应字节的数倍。仅用于非流式 list 响应;watch 流保持字节级透传。
export function slimListBody(body) {
  if (!body || !Array.isArray(body.items)) return body
  for (const it of body.items) {
    const m = it?.metadata
    if (!m) continue
    if (m.managedFields) delete m.managedFields
    if (m.annotations && 'kubectl.kubernetes.io/last-applied-configuration' in m.annotations) {
      delete m.annotations['kubectl.kubernetes.io/last-applied-configuration']
    }
  }
  return body
}
```

`server/index.mjs` 修改(非流式分支,K8s 代理 `try {` 块内,`return sendJson(res, result.status, result.body ?? {})` 前):

```js
import { slimListBody } from './k8s-slim.mjs'   // 文件顶部 import 区
```

```js
    // list GET 响应剥冗余(managedFields/last-applied);单对象 GET 与写操作不动
    if (req.method === 'GET' && Array.isArray(result.body?.items)) slimListBody(result.body)
    return sendJson(res, result.status, result.body ?? {})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/k8s-list-slim.test.mjs`
Expected: PASS(2 tests)

- [ ] **Step 5: 回归网关全量测试**

Run: `npm run test:server`
Expected: 全绿(新增文件被 `node --test server/*.test.mjs` 自动收编)

- [ ] **Step 6: Commit**

```bash
git add server/k8s-slim.mjs server/k8s-list-slim.test.mjs server/index.mjs
git commit -m "feat(gateway): K8s list 响应剥 managedFields/last-applied——workload 族瘦身第一刀"
```

---

### Task 2: watchRegistry + createWatchController 状态机

**Files:**
- Create: `src/composables/watchRegistry.js`
- Create: `src/composables/useClusterWatch.js`
- Test: `src/composables/__tests__/useClusterWatch.test.js`

**Interfaces:**
- Produces:
  - `recordListRv(path, rv)` / `getListRv(path)` / `clearWatchRegistry()`(watchRegistry.js)
  - `createWatchController({ connect, relist, onState, baseMs?, maxMs?, maxFailures? })` → `{ start(), stop() }`(useClusterWatch.js)
  - `connect({ onOpen, onError, onClose })` 契约:返回 `{ abort() }`;`onError(err)` 中 `err.status === 410` 表示 RV 失效
  - 常量 `WATCH_BACKOFF_BASE_MS=1000, WATCH_BACKOFF_MAX_MS=60000, WATCH_MAX_FAILURES=5, WATCH_DEGRADED_RETRY_MS=60000`

- [ ] **Step 1: 写失败测试**

`src/composables/__tests__/useClusterWatch.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWatchController, WATCH_BACKOFF_BASE_MS, WATCH_DEGRADED_RETRY_MS } from '../useClusterWatch'
import { recordListRv, getListRv, clearWatchRegistry } from '../watchRegistry'

beforeEach(() => { vi.useFakeTimers(); clearWatchRegistry() })
afterEach(() => vi.useRealTimers())

// 假 connect:捕获 handlers,由测试主动触发 onOpen/onError/onClose 模拟流断开
function makeFakeConnect() {
  const calls = []
  const connect = handlers => {
    const h = { handlers, aborted: false, abort: () => { h.aborted = true } }
    calls.push(h)
    return h
  }
  return { connect, calls }
}

describe('createWatchController', () => {
  it('start 后连接成功 → live;正常 stop 调 abort', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start()
    expect(states).toEqual(['reconnecting'])     // start 即「连接中」,首次 onOpen 才 live
    calls[0].handlers.onOpen()
    expect(states).toEqual(['reconnecting', 'live'])
    c.stop()
    expect(calls[0].aborted).toBe(true)
  })

  it('断流按指数退避重连:1s→2s→4s;恢复即回 live 且计数清零', () => {
    const { connect, calls } = makeFakeConnect()
    const c = createWatchController({ connect, relist: vi.fn(), onState: vi.fn() })
    c.start(); calls[0].handlers.onOpen()
    calls[0].handlers.onError(new Error('x'))          // 失败1 → 1s 后重连
    vi.advanceTimersByTime(WATCH_BACKOFF_BASE_MS - 1); expect(calls.length).toBe(1)
    vi.advanceTimersByTime(1); expect(calls.length).toBe(2)
    calls[1].handlers.onError(new Error('x'))          // 失败2 → 2s
    vi.advanceTimersByTime(1999); expect(calls.length).toBe(2)
    vi.advanceTimersByTime(1); expect(calls.length).toBe(3)
    calls[2].handlers.onOpen()                          // 恢复
    calls[2].handlers.onError(new Error('x'))          // 又从 1s 起退避(计数已清零)
    vi.advanceTimersByTime(WATCH_BACKOFF_BASE_MS); expect(calls.length).toBe(4)
    c.stop()
  })

  it('410 不计失败:先 relist 再重开', async () => {
    const { connect, calls } = makeFakeConnect()
    const relist = vi.fn()
    const states = []
    const c = createWatchController({ connect, relist, onState: s => states.push(s) })
    c.start(); calls[0].handlers.onOpen()
    calls[0].handlers.onError(Object.assign(new Error('gone'), { status: 410 }))
    await vi.advanceTimersByTimeAsync(0)               // 微任务 flushed
    expect(relist).toHaveBeenCalledTimes(1)
    expect(states).toContain('reconnecting')
    calls[1].handlers.onOpen()
    expect(states[states.length - 1]).toBe('live')
    c.stop()
  })

  it('连续 5 次失败 → degraded;降级期 60s 重试,成功回 live', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start()
    for (let i = 0; i < 5; i++) { calls[i].handlers.onError(new Error('x')); vi.advanceTimersByTime(WATCH_DEGRADED_RETRY_MS) }
    expect(states).toContain('degraded')
    expect(calls.length).toBe(6)                        // 第 6 次 = 降级重试
    calls[5].handlers.onOpen()
    expect(states[states.length - 1]).toBe('live')
    c.stop()
  })

  it('stop 后的迟到回调不再驱动状态机', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start(); calls[0].handlers.onOpen()
    c.stop()
    calls[0].handlers.onError(new Error('late'))
    vi.advanceTimersByTime(WATCH_DEGRADED_RETRY_MS * 3)
    expect(calls.length).toBe(1)
    expect(states).toEqual(['reconnecting', 'live'])
  })
})

describe('watchRegistry', () => {
  it('list RV 按路径登记/读取;空值不覆盖', () => {
    recordListRv('/api/v1/pods', '100')
    recordListRv('/api/v1/pods', undefined)
    expect(getListRv('/api/v1/pods')).toBe('100')
    expect(getListRv('/apis/apps/v1/deployments')).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useClusterWatch.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

`src/composables/watchRegistry.js`:

```js
// watch resourceVersion 登记簿:每次 list(初次 fetch/降级轮询)把响应 RV 按资源路径存此,
// watch 重连从该 RV 续接只收断线期间变更。纯模块级 Map,useFetchers 写、cluster store 读,
// 无循环依赖。切集群时 clearWatchRegistry()(store 负责)。
const _rvs = new Map()
export function recordListRv(path, rv) { if (rv) _rvs.set(path, String(rv)) }
export function getListRv(path) { return _rvs.get(path) || '' }
export function clearWatchRegistry() { _rvs.clear() }
```

`src/composables/useClusterWatch.js`:

```js
// K8s watch 控制器状态机(纯逻辑,依赖注入可测):
//   live --断流(非410)--> reconnecting --退避重连-->
//   任意 --410--> reconnecting + relist 后重开(不计失败)
//   连续 maxFailures 次失败 --> degraded(60s 慢重试,期间页面回落轮询)
//   任一次成功 open --> live 且失败计数清零
// 推翻旧「手动恢复」决策(spec §3 决策2),风暴风险由退避+降级控制。
export const WATCH_BACKOFF_BASE_MS = 1000
export const WATCH_BACKOFF_MAX_MS = 60000
export const WATCH_MAX_FAILURES = 5
export const WATCH_DEGRADED_RETRY_MS = 60000

export function createWatchController({ connect, relist, onState, baseMs = WATCH_BACKOFF_BASE_MS, maxMs = WATCH_BACKOFF_MAX_MS, maxFailures = WATCH_MAX_FAILURES }) {
  let state = 'off'
  let failures = 0
  let timer = null
  let stopped = true
  let handle = null

  const setState = s => { state = s; onState?.(s) }
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  const delayFor = n => Math.min(baseMs * 2 ** (n - 1), maxMs)

  function open() {
    clearTimer()
    if (handle) { try { handle.abort() } catch { /* noop */ } }
    handle = connect({
      onOpen: () => { failures = 0; setState('live') },
      onError: err => onFailure(err),
      onClose: () => onFailure(null),
    })
  }

  function onFailure(err) {
    if (stopped) return
    clearTimer()
    if (err?.status === 410) {                       // RV 失效:relist 拿新 RV 再重开,不计失败
      setState('reconnecting')
      Promise.resolve(relist?.()).finally(() => { if (!stopped) open() })
      return
    }
    failures += 1
    if (failures >= maxFailures) {                   // 降级:页面轮询接管,60s 慢重试
      setState('degraded')
      timer = setTimeout(() => { if (!stopped) open() }, WATCH_DEGRADED_RETRY_MS)
      return
    }
    setState('reconnecting')
    timer = setTimeout(() => { if (!stopped) open() }, delayFor(failures))
  }

  return {
    start() { if (!stopped) return; stopped = false; failures = 0; setState('reconnecting'); open() },
    stop() { stopped = true; clearTimer(); if (handle) { try { handle.abort() } catch { /* noop */ } } handle = null },
    get state() { return state },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useClusterWatch.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/composables/watchRegistry.js src/composables/useClusterWatch.js src/composables/__tests__/useClusterWatch.test.js
git commit -m "feat(datalayer): watch 控制器状态机——退避重连/410 relist/降级兜底(纯逻辑 DI 可测)"
```

---

### Task 3: k8sStream 增加 onOpen/status + store 七资源接线

**Files:**
- Modify: `src/api/client.js:370-380`(k8sStream 加 `onOpen` 回调与 `err.status`)
- Modify: `src/stores/cluster.js`(watch 配置表、控制器实例、启动锚点、RV 登记、live 状态暴露)
- Modify: `src/composables/useFetchers.js`(fetchWorkloads/fetchServices/fetchIngresses/fetchPods 登记 RV)
- Modify: `src/locales/zh.json` / `src/locales/en.json`(watch 三态文案)
- Test: `src/stores/__tests__/clusterWatchWiring.test.js`

**Interfaces:**
- Consumes: Task 2 的 `createWatchController`/`recordListRv`/`getListRv`;既有 `k8sStream`/`applyWatchEvent`/`mapXxx`。
- Produces:
  - `k8sStream(path, { onMessage, onError, onClose, onOpen })`;`onError` 的 Error 带 `.status`(HTTP 状态码)
  - store 新增:`watchStates`(reactive,per-watch-key)、`watchStateOf(queryKey)` → `'live'|'reconnecting'|'degraded'|'off'`、`startWorkloadFamilyWatch()`/`stopWorkloadFamilyWatch()`
  - 兼容保留:`startPodWatch/stopPodWatch/podWatchLive`、`startEventWatch/stopEventWatch`(内部委托控制器)

- [ ] **Step 1: k8sStream 加 onOpen 与 err.status(client.js)**

`src/api/client.js` k8sStream 内,`if (!response.ok)` 分支的 throw 改为携带状态码,并在 ok 后通知 onOpen:

```js
export function k8sStream(path, { onMessage, onError, onClose, onOpen } = {}) {
  // ...前置不变...
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const body = parseBody(text)
        throw Object.assign(new Error(body?.message || i18n.global.t('store.streamFailed', { status: response.status })), { status: response.status })
      }
      onOpen?.()
      reader = response.body.getReader()
  // ...后续不变...
```

- [ ] **Step 2: 写失败测试(store 接线)**

`src/stores/__tests__/clusterWatchWiring.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模块级 mock 必配 reset(既有教训):每用例重置注册表
const streamMocks = []
vi.mock('@/api/client', () => ({
  k8sStream: vi.fn((path, handlers) => {
    const h = { path, handlers, abort: vi.fn() }
    streamMocks.push(h)
    return h
  }),
  api: { k8s: vi.fn() },
  getSavedClusters: vi.fn(() => []), addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(), activeApiServer: vi.fn(), getSessionToken: vi.fn(() => 't'),
}))
vi.mock('@/composables/useFetchers', () => new Proxy({}, { get: () => vi.fn(async () => []) }))

import { useClusterStore } from '@/stores/cluster'
import { createPinia, setActivePinia } from 'pinia'

beforeEach(() => { setActivePinia(createPinia()); streamMocks.length = 0 })

describe('cluster store watch 接线', () => {
  it('startWorkloadFamilyWatch 建立 7 条 watch(workloads 三类+services+ingresses+pods+events),幂等', async () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    store.startWorkloadFamilyWatch()                    // 幂等:不重复建流
    const paths = streamMocks.map(h => h.path.split('?')[0])
    expect(paths.filter(p => p === '/apis/apps/v1/deployments')).toHaveLength(1)
    expect(paths.filter(p => p === '/apis/apps/v1/statefulsets')).toHaveLength(1)
    expect(paths.filter(p => p === '/apis/apps/v1/daemonsets')).toHaveLength(1)
    expect(paths).toContain('/api/v1/services')
    expect(paths).toContain('/apis/networking.k8s.io/v1/ingresses')
    expect(paths).toContain('/api/v1/pods')
    expect(paths).toContain('/api/v1/events')
    expect(streamMocks.length).toBe(7)
  })

  it('workloads 三类事件 merge 进同一 queryKey;watchStateOf 聚合三态', async () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    expect(store.watchStateOf('workloads')).toBe('reconnecting')  // 未 onOpen 前
    for (const h of streamMocks) h.handlers.onOpen?.()
    expect(store.watchStateOf('workloads')).toBe('live')
    // deployments 流断开一条 → 不再全 live;五连败一条 → degraded
    const dep = streamMocks.find(h => h.path.startsWith('/apis/apps/v1/deployments'))
    for (let i = 0; i < 5; i++) dep.handlers.onError(new Error('x'))
    expect(store.watchStateOf('workloads')).toBe('degraded')
    store.stopWorkloadFamilyWatch()
  })

  it('事件消息 setQueryData 走 canonical key', async () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    const svc = streamMocks.find(h => h.path.startsWith('/api/v1/services'))
    svc.handlers.onOpen?.()
    svc.handlers.onMessage(JSON.stringify({ type: 'ADDED', object: { metadata: { name: 'svc1', namespace: 'default', uid: 'u1', resourceVersion: '9' } }, spec: {}, status: {} }))
    // store 内部用 Pinia 测试插件的 queryClient;直接断言 watchStates 仍 live + registry RV 前滚
    expect(store.watchStateOf('services')).toBe('live')
    store.stopWorkloadFamilyWatch()
  })
})
```

注:queryClient 在 cluster.js 本就是模块级单例(`cluster.js:13 import { queryClient } from '@/queryClient'`),测试无需注入;Pinia 用 `setActivePinia(createPinia())` 每用例新实例(上面 beforeEach 已含)。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/clusterWatchWiring.test.js`
Expected: FAIL(`store.startWorkloadFamilyWatch is not a function`)

- [ ] **Step 4: 实现 store 接线**

`src/stores/cluster.js`:

顶部 import 增加:

```js
import { createWatchController } from '@/composables/useClusterWatch'
import { recordListRv, getListRv, clearWatchRegistry } from '@/composables/watchRegistry'
```

另:vue import 行(cluster.js:2 `import { ref, computed } from 'vue'`)补 `reactive`(下方 watchStates 用)。`queryClient` 已是模块级单例(cluster.js:13),直接复用。

替换 `startPodWatch/startEventWatch/stopPodWatch/stopEventWatch` 区块(cluster.js:699-751)为:

```js
  // === Workload 族 Watch:7 条长连接增量写 Vue Query canonical key ===
  // spec §5.3:deployments/statefulsets/daemonsets 三流 merge 进同一 'workloads' key;
  // 断线由 createWatchController 退避重连/410 relist/降级轮询接管。
  const WATCH_CONFIGS = [
    { key: 'pods', queryKey: 'pods', watchPath: '/api/v1/pods', mapFn: mapPod },
    { key: 'events', queryKey: 'events', watchPath: '/api/v1/events', mapFn: mapEvent },
    { key: 'deployments', queryKey: 'workloads', watchPath: '/apis/apps/v1/deployments', mapFn: i => mapWorkload(i, 'Deployment') },
    { key: 'statefulsets', queryKey: 'workloads', watchPath: '/apis/apps/v1/statefulsets', mapFn: i => mapWorkload(i, 'StatefulSet') },
    { key: 'daemonsets', queryKey: 'workloads', watchPath: '/apis/apps/v1/daemonsets', mapFn: i => mapWorkload(i, 'DaemonSet') },
    { key: 'services', queryKey: 'services', watchPath: '/api/v1/services', mapFn: mapService },
    { key: 'ingresses', queryKey: 'ingresses', watchPath: '/apis/networking.k8s.io/v1/ingresses', mapFn: mapIngress },
  ]
  const watchStates = reactive(Object.fromEntries(WATCH_CONFIGS.map(c => [c.key, 'off'])))
  const watchControllers = new Map()

  function relistQueryKey(queryKey) {
    return queryClient.refetchQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === queryKey })
  }

  function controllerFor(cfg) {
    if (watchControllers.has(cfg.key)) return watchControllers.get(cfg.key)
    const ctl = createWatchController({
      connect: ({ onOpen, onError, onClose }) => {
        const rv = getListRv(cfg.watchPath)
        return k8sStream(`${cfg.watchPath}?watch=true${rv ? `&resourceVersion=${encodeURIComponent(rv)}` : ''}`, {
          onOpen,
          onClose,
          onError,
          onMessage: line => {
            try {
              const evt = JSON.parse(line)
              if (evt.object?.metadata?.resourceVersion) recordListRv(cfg.watchPath, evt.object.metadata.resourceVersion)
              const _cid = currentCluster.value || 'cluster'
              queryClient.setQueryData(['cluster', _cid, cfg.queryKey], old => applyWatchEvent(old || [], evt.type, cfg.mapFn(evt.object)))
            } catch { /* 忽略非 JSON 心跳行 */ }
          },
        })
      },
      relist: () => relistQueryKey(cfg.queryKey),
      onState: s => {
        watchStates[cfg.key] = s
        if (cfg.key === 'pods') podWatchLive.value = s === 'live'
        if (cfg.key === 'events') eventWatchLive.value = s === 'live'
      },
    })
    watchControllers.set(cfg.key, ctl)
    return ctl
  }

  function startWorkloadFamilyWatch() {
    for (const cfg of WATCH_CONFIGS) controllerFor(cfg).start()
  }
  function stopWorkloadFamilyWatch() {
    for (const ctl of watchControllers.values()) ctl.stop()
    clearWatchRegistry()
  }
  // canonical queryKey 聚合态:全 live 才 live;任一 degraded 即 degraded
  function watchStateOf(queryKey) {
    const ss = WATCH_CONFIGS.filter(c => c.queryKey === queryKey).map(c => watchStates[c.key])
    if (!ss.length || ss.every(s => s === 'off')) return 'off'
    if (ss.some(s => s === 'degraded')) return 'degraded'
    if (ss.some(s => s === 'reconnecting')) return 'reconnecting'
    if (ss.every(s => s === 'live')) return 'live'
    return 'off'
  }
  // 旧入口兼容(NsPods toggleLive / NsEvents / AuditLogs / MonitoringCenter 既存调用点)
  function startPodWatch() { controllerFor(WATCH_CONFIGS[0]).start() }
  function stopPodWatch() { controllerFor(WATCH_CONFIGS[0]).stop() }
  function startEventWatch() { controllerFor(WATCH_CONFIGS[1]).start() }
  function stopEventWatch() { controllerFor(WATCH_CONFIGS[1]).stop() }
```

启动锚点(三处,各加一行):

1. `setConnectedCluster`(cluster.js:1029 `startHealthCheck()` 后):`startWorkloadFamilyWatch()`
2. `switchCluster`(cluster.js:997 `startHealthCheck()` 后):`startWorkloadFamilyWatch()`;并把 986-987 行 `stopPodWatch()/stopEventWatch()` 替换为 `stopWorkloadFamilyWatch()`
3. `AppLayout.vue:48`:`store.hydrateCriticalResources({ silent: true }).then(() => store.startWorkloadFamilyWatch()).catch(() => {})`(刷新恢复会话场景)

`useFetchers.js` RV 登记(四处,在各自 `api.k8s` 返回后):

```js
// fetchWorkloads 内(拆分前先加,Task 5 再瘦身):
recordListRv('/apis/apps/v1/deployments', dep?.metadata?.resourceVersion)
recordListRv('/apis/apps/v1/statefulsets', sts?.metadata?.resourceVersion)
recordListRv('/apis/apps/v1/daemonsets', ds?.metadata?.resourceVersion)
// fetchServices:
recordListRv('/api/v1/services', d?.metadata?.resourceVersion)
// fetchIngresses:
recordListRv('/apis/networking.k8s.io/v1/ingresses', d?.metadata?.resourceVersion)
// fetchPods(cluster.js:1038 store 内):
recordListRv('/api/v1/pods', podData?.metadata?.resourceVersion)
// fetchEvents(cluster.js:1062 store 内):
recordListRv('/api/v1/events', d?.metadata?.resourceVersion)
```

store return 导出区(cluster.js:1887 起)增加:`watchStates, watchStateOf, startWorkloadFamilyWatch, stopWorkloadFamilyWatch`。

i18n(zh.json/en.json,`common` 节):

```json
"watchLive": "实时", "watchReconnecting": "重连中", "watchDegraded": "已降级轮询"
"watchLive": "Live", "watchReconnecting": "Reconnecting", "watchDegraded": "Degraded (polling)"
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/clusterWatchWiring.test.js`
Expected: PASS(3 tests)

- [ ] **Step 6: 回归既有 watch 消费者测试**

Run: `npx vitest run`
Expected: 全绿(NsPods/NsEvents 等既有用例不受兼容层影响)

- [ ] **Step 7: Commit**

```bash
git add src/api/client.js src/stores/cluster.js src/composables/useFetchers.js src/locales/zh.json src/locales/en.json src/stores/__tests__/clusterWatchWiring.test.js src/components/layout/AppLayout.vue
git commit -m "feat(datalayer): workload 族 7 条 watch 接线——控制器/启动锚点/RV 登记/聚合三态"
```

---

### Task 4: fetchWorkloadRevisions(回滚历史独立 fetcher)

**Files:**
- Modify: `src/composables/useFetchers.js`(attachRolloutHistory 抽单对象逻辑 + 新 fetcher)
- Modify: `src/stores/cluster.js`(re-export)
- Test: `src/composables/__tests__/useWorkloadRevisions.test.js`

**Interfaces:**
- Produces: `fetchWorkloadRevisions(type, name, ns)` → `Promise<rev[]>`,rev 形状与今日一致(`{rev,image,sha,age,reason,current,replicas,readyReplicas,desiredReplicas,rsName,rsUid,_template}`);非 Deployment 返回单条当前版本(无 `_template`)
- Consumes: 既有 `api.k8s`、`mapWorkload`

- [ ] **Step 1: 写失败测试**

`src/composables/__tests__/useWorkloadRevisions.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const k8sMock = vi.fn()
vi.mock('@/api/client', () => ({ api: { k8s: (...a) => k8sMock(...a) } }))
beforeEach(() => { k8sMock.mockReset() })

import { fetchWorkloadRevisions } from '../useFetchers'

const deploy = { metadata: { name: 'web', namespace: 'default', annotations: { 'deployment.kubernetes.io/revision': '2' } } }
const rs = rev => ({ metadata: { name: `web-${rev}`, namespace: 'default', uid: `u${rev}`, annotations: { 'deployment.kubernetes.io/revision': String(rev) }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'web' }] }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'c', image: `img:${rev}` }] } } }, status: { replicas: 1 } })
const otherRs = { ...rs(9), metadata: { ...rs(9).metadata, name: 'other-9', ownerReferences: [{ kind: 'Deployment', controller: true, name: 'other' }] } }

describe('fetchWorkloadRevisions', () => {
  it('Deployment:拉单对象+ns 级 RS,按 ownerReferences 过滤,rev 降序,带 _template', async () => {
    k8sMock.mockImplementation(async p => {
      if (p.includes('/deployments/web')) return deploy
      if (p.includes('/namespaces/default/replicasets')) return { items: [rs(1), rs(2), otherRs] }
      throw new Error('unexpected ' + p)
    })
    const revs = await fetchWorkloadRevisions('Deployment', 'web', 'default')
    expect(revs.map(r => r.rev)).toEqual([2, 1])            // 降序且滤掉 otherRs
    expect(revs[0].current).toBe(true); expect(revs[1].current).toBe(false)
    expect(revs[0]._template.spec.containers[0].image).toBe('img:2')
  })

  it('StatefulSet/DaemonSet:单条当前版本,无 _template(现状语义)', async () => {
    k8sMock.mockResolvedValue({ metadata: { name: 'mysql' }, spec: { template: { spec: { containers: [{ name: 'c', image: 'mysql:8' }] } } } })
    const revs = await fetchWorkloadRevisions('StatefulSet', 'mysql', 'default')
    expect(revs).toHaveLength(1); expect(revs[0].current).toBe(true); expect(revs[0]._template).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useWorkloadRevisions.test.js`
Expected: FAIL(`fetchWorkloadRevisions is not a function`)

- [ ] **Step 3: 实现**

`useFetchers.js`:从 `attachRolloutHistory` 中抽出单 Deployment 的构建函数(列表版改为循环调用它,暂保列表行为不变——Task 5 再把列表调用拆掉):

```js
// 单个 Deployment 的发布历史(deploy 对象 + 其 owned ReplicaSets → rev[])
export function buildRevisions(deploy, ownedRs) {
  const curRev = deploy?.metadata?.annotations?.['deployment.kubernetes.io/revision'] || ''
  const base = { name: deploy?.metadata?.name || '', namespace: deploy?.metadata?.namespace || '', image: deploy?.spec?.template?.spec?.containers?.[0]?.image || '' }
  const revs = ownedRs.map(rs => {
    const rev = Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0
    return {
      rev,
      image: rs.spec?.template?.spec?.containers?.[0]?.image || base.image,
      sha: String(rs.metadata?.uid || '').slice(0, 7) || String(rs.metadata?.name || '').split('-').pop() || '—',
      age: ageOf(rs.metadata?.creationTimestamp),
      reason: rs.metadata?.annotations?.['kubernetes.io/change-cause'] || (rev ? `revision ${rev}` : '—'),
      current: curRev ? String(rev) === String(curRev) : false,
      replicas: rs.status?.replicas ?? rs.spec?.replicas ?? 0,
      readyReplicas: rs.status?.readyReplicas ?? 0,
      desiredReplicas: rs.spec?.replicas ?? rs.status?.replicas ?? 0,
      rsName: rs.metadata?.name,
      rsUid: rs.metadata?.uid,
      _template: rs.spec?.template,
    }
  }).filter(r => r.rev > 0).sort((a, b) => b.rev - a.rev)
  return revs.length ? revs : [{ rev: Number(curRev) || 1, image: base.image, sha: '—', age: ageOf(deploy?.metadata?.creationTimestamp), reason: i18n.global.t('store.currentVersion'), current: true }]
}

// 回滚历史独立 fetcher:仅详情页/回滚按需拉(共享列表不再携带全史,spec §5.2 第一刀)
export async function fetchWorkloadRevisions(type, name, ns) {
  if (type !== 'Deployment') {
    const plural = { StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[type]
    if (!plural) return []
    const d = await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`)
    return [{ rev: 1, image: d?.spec?.template?.spec?.containers?.[0]?.image || '', sha: '—', age: ageOf(d?.metadata?.creationTimestamp), reason: i18n.global.t('store.currentVersion'), current: true }]
  }
  const [deploy, rsList] = await Promise.all([
    api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`),
    api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/replicasets?limit=500`),
  ])
  const owned = (rsList?.items || []).filter(rs => (rs.metadata?.ownerReferences || []).some(o => o.kind === 'Deployment' && o.controller && o.name === name))
  return buildRevisions(deploy, owned)
}
```

`cluster.js` import 行(:15)与 return 导出区追加 `fetchWorkloadRevisions`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useWorkloadRevisions.test.js`
Expected: PASS(2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/composables/useFetchers.js src/stores/cluster.js src/composables/__tests__/useWorkloadRevisions.test.js
git commit -m "feat(datalayer): fetchWorkloadRevisions——回滚历史按需拉(单 Deployment+owned RS,buildRevisions 单源)"
```

---

### Task 5: fetchWorkloads 瘦身 + rollbackWorkload/NsWorkloadDetail 改源

**Files:**
- Modify: `src/composables/useFetchers.js:97-115`(fetchWorkloads 去 RS)
- Modify: `src/stores/cluster.js:646-668`(rollbackWorkload 改源)
- Modify: `src/views/NsWorkloadDetail.vue:281`(revisions 换 query)、`:383`(删 rev 改 setQueryData)、`:337` 附近(回滚后 refetch)
- Test: `src/stores/__tests__/rollbackTemplate.test.js`

**Interfaces:**
- Consumes: Task 4 `fetchWorkloadRevisions`
- Produces: `fetchWorkloads()` 不再返回带 `revisions` 的对象(消费方仅 NsWorkloadDetail,本任务同步改)

- [ ] **Step 1: 写失败测试(回滚护栏:PATCH 请求体含完整 template)**

`src/stores/__tests__/rollbackTemplate.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const k8sMock = vi.fn()
vi.mock('@/api/client', () => ({
  api: { k8s: (...a) => k8sMock(...a) },
  k8sStream: vi.fn(), getSavedClusters: vi.fn(() => []), addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(), activeApiServer: vi.fn(), getSessionToken: vi.fn(() => 't'),
}))
// 注意:不 mock useFetchers——rollbackWorkload 走真实 fetchWorkloadRevisions,
// 其 api.k8s 由上面的 k8sMock 供数( mock 整个 useFetchers 会把被测链路一起吞掉)
vi.mock('@/composables/useClusterWatch', () => ({ createWatchController: () => ({ start: vi.fn(), stop: vi.fn() }) }))

import { useClusterStore } from '@/stores/cluster'

beforeEach(() => { k8sMock.mockReset() })

describe('rollbackWorkload 护栏', () => {
  it('回滚到 rev2 的 PATCH body.spec.template 与该 rev ReplicaSet 的完整模板一致', async () => {
    const deploy = { metadata: { name: 'web', namespace: 'default', annotations: { 'deployment.kubernetes.io/revision': '3' } } }
    const tpl = rev => ({ metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'c', image: `img:${rev}` }] } })
    const rsList = { items: [1, 2].map(rev => ({ metadata: { name: `web-${rev}`, uid: `u${rev}`, annotations: { 'deployment.kubernetes.io/revision': String(rev) }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'web' }] }, spec: { template: tpl(rev) }, status: {} })) }
    k8sMock.mockImplementation(async p => {
      if (p.includes('/deployments/web') && !p.includes('replicasets')) return deploy
      if (p.includes('/namespaces/default/replicasets')) return rsList
      return {}
    })
    const store = useClusterStore()
    await store.rollbackWorkload('web', 'default', 2)
    const patchCall = k8sMock.mock.calls.find(c => c[1]?.method === 'PATCH')
    expect(patchCall).toBeTruthy()
    const body = JSON.parse(patchCall[1].body)
    expect(body.spec.template).toEqual(tpl(2))              // 完整模板,非镜像兜底
    expect(body.spec.template.spec.containers[0].image).toBe('img:2')
  })
})
```

(Pinia 环境 Setup 同 Task 3 Step 2 备注。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/rollbackTemplate.test.js`
Expected: FAIL(现 rollbackWorkload 从 getWorkloadForEdit 的缓存对象读 revisions,缓存为空 → revisionNotFound)

- [ ] **Step 3: 实现**

`useFetchers.js` `fetchWorkloads` 瘦身(保留 Task 3 加的三行 RV 登记):

```js
// 工作负载列表(deploy+sts+ds 三类合一)。瘦身:不再拉 replicasets/回滚历史——
// 历史仅 NsWorkloadDetail 回滚页需要,走 fetchWorkloadRevisions 按需拉(spec §5.2 第一刀)。
export async function fetchWorkloads() {
  const [dep, sts, ds] = await Promise.all([
    api.k8s('/apis/apps/v1/deployments?limit=1000'),
    api.k8s('/apis/apps/v1/statefulsets?limit=1000'),
    api.k8s('/apis/apps/v1/daemonsets?limit=1000'),
  ])
  recordListRv('/apis/apps/v1/deployments', dep?.metadata?.resourceVersion)
  recordListRv('/apis/apps/v1/statefulsets', sts?.metadata?.resourceVersion)
  recordListRv('/apis/apps/v1/daemonsets', ds?.metadata?.resourceVersion)
  return [
    ...((dep?.items || []).map(i => mapWorkload(i, 'Deployment'))),
    ...((sts?.items || []).map(i => mapWorkload(i, 'StatefulSet'))),
    ...((ds?.items || []).map(i => mapWorkload(i, 'DaemonSet'))),
  ]
}
```

(`attachRolloutHistory` 若再无调用方则整段删除;`buildRevisions` 已由 Task 4 接管。)

`cluster.js` `rollbackWorkload`(646-668)改源:

```js
  async function rollbackWorkload(name, ns, revNumber) {
    const wl = await getWorkloadForEdit(name, ns)
    if (!wl) { invalidateResource('workloads'); throw new Error(i18n.global.t('store.workloadNotFound')) }
    const revs = await fetchWorkloadRevisions(wl.type, name, ns)
    const target = (revs || []).find(r => r.rev === revNumber)
    if (!target) throw new Error(i18n.global.t('store.revisionNotFound', { rev: revNumber }))
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
    if (plural) {
      const body = target._template
        ? { spec: { template: target._template }, metadata: { labels: { 'aliangboard.io/managed-by': 'aliangboard' }, annotations: { 'aliangboard.io/last-edited': new Date().toISOString(), 'aliangboard.io/last-action': `rollback-to-rev-${revNumber}` } } }
        : { spec: { template: { spec: { containers: [{ name: wl.name, image: target.image }] } } }, metadata: { labels: { 'aliangboard.io/managed-by': 'aliangboard' }, annotations: { 'aliangboard.io/last-edited': new Date().toISOString(), 'aliangboard.io/last-action': `rollback-to-rev-${revNumber}` } } }
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify(body),
      })
    }
    invalidateResource('workloads')
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === 'revisions' })
  }
```

`NsWorkloadDetail.vue`:

`:281` 换数据源(import 区补 `useResourceDetail`、`useQueryClient`;文件已 import `useResourceList` 同源):

```js
const TYPE_MAP = { deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet' }
const revisionsQuery = useResourceDetail({
  key: ['cluster', cid, 'revisions', route.params.namespace, route.params.name],
  fetcher: () => store.fetchWorkloadRevisions(TYPE_MAP[String(route.params.type).toLowerCase()] || workload.value?.type || 'Deployment', route.params.name, route.params.namespace),
  options: { enabled: isRolloutType },
})
const revisions = computed(() => revisionsQuery.data.value || [])
```

(`isRolloutType` 定义在 :279,`cid` 已存在于本文件;若声明顺序导致 `isRolloutType` 未定义先引用,把 `enabled` 换成 `() => isRolloutType.value` 闭包惰性求值。)

`:383` 删 rev 后改缓存:

```js
    queryClient.setQueryData(['cluster', cid.value, 'revisions', route.params.namespace, route.params.name], (old = []) => old.filter(r => r.rev !== rev.rev))
```

`:337` 回滚成功后补拉(`await store.rollbackWorkload(...)` 之后):

```js
    revisionsQuery.refetch()
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/stores/__tests__/rollbackTemplate.test.js && npx vitest run`
Expected: 全绿(若有旧用例断言 fetchWorkloads 带 revisions,同步修正断言——记录于提交信息)

- [ ] **Step 5: Commit**

```bash
git add src/composables/useFetchers.js src/stores/cluster.js src/views/NsWorkloadDetail.vue src/stores/__tests__/rollbackTemplate.test.js
git commit -m "feat(datalayer): fetchWorkloads 瘦身(去 RS 全史)+回滚改源 fetchWorkloadRevisions+护栏测试"
```

---

### Task 6: 缓存策略 + NsLayers 三态/响应式轮询 + WatchStateChip

**Files:**
- Modify: `src/composables/useK8sQuery.js:43`(gcTime 默认)
- Create: `src/components/common/WatchStateChip.vue`
- Modify: `src/views/NsLayers.vue`(三态 + 响应式 interval)
- Test: `src/components/common/__tests__/WatchStateChip.test.js`、`src/views/__tests__/NsLayers.states.test.js`

**Interfaces:**
- Consumes: Task 3 `store.watchStateOf`
- Produces: `WatchStateChip` props `{ state: String }`(`live|reconnecting|degraded|off`→off 不渲染);`useResourceList` 默认 `gcTime: Infinity`

- [ ] **Step 1: 写失败测试**

`src/components/common/__tests__/WatchStateChip.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WatchStateChip from '../WatchStateChip.vue'

describe('WatchStateChip', () => {
  it('live/reconnecting/degraded 渲染对应文案;off 不渲染', () => {
    expect(mount(WatchStateChip, { props: { state: 'live' } }).text()).toContain('实时')
    expect(mount(WatchStateChip, { props: { state: 'reconnecting' } }).text()).toContain('重连中')
    expect(mount(WatchStateChip, { props: { state: 'degraded' } }).text()).toContain('已降级轮询')
    expect(mount(WatchStateChip, { props: { state: 'off' } }).find('*').exists()).toBe(false)
  })
})
```

(vitest 环境默认 locale zh;若项目 vitest 设 en,断言改为对应英文键——以 `src/components/common/__tests__/` 既有用例的 i18n 处理为准,无先例则在测试内 `config.global.plugins` 挂 zh messages。)

`src/views/__tests__/NsLayers.states.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const dataRef = { value: null }
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: vi.fn(() => ({ data: dataRef, isPending: { value: dataRef.value === null }, refetch: vi.fn() })),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'default' } }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import NsLayers from '../../NsLayers.vue'

beforeEach(() => { dataRef.value = null })

describe('NsLayers 三态', () => {
  it('无数据且 pending → 显示加载态(非空状态文案);空数组 → 真空态', async () => {
    const w = mount(NsLayers, { global: { stubs: ['Modal', 'Breadcrumbs', 'StatusChip'] } })
    expect(w.text()).not.toContain('emptyState')          // 加载中不误报空
    dataRef.value = []
    await flushPromises()
    // 空数组 → 空状态卡片(渲染 ns.layers.emptyState 文案)
    expect(w.find('[data-test="layers-empty"]').exists()).toBe(true)
  })
})
```

(空状态卡片加 `data-test="layers-empty"` 属性以便断言;`emptyState` 文案键在 i18n 全局缺失时该断言只查 data-test,与文案解耦。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/WatchStateChip.test.js src/views/__tests__/NsLayers.states.test.js`
Expected: FAIL(组件不存在/无 data-test)

- [ ] **Step 3: 实现**

`useK8sQuery.js:43`:`gcTime: options.gcTime ?? 5 * 60_000` → `gcTime: options.gcTime ?? Infinity`,注释改为:

```js
    gcTime: options.gcTime ?? Infinity,   // 缓存永驻:正确性靠 watch 纠偏 + mutation 显式 invalidate(spec §5.1)
```

`WatchStateChip.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({ state: { type: String, default: 'off' } })
const { t } = useI18n()
const META = {
  live: { icon: 'podcasts', key: 'common.watchLive', cls: 'text-primary' },
  reconnecting: { icon: 'sync', key: 'common.watchReconnecting', cls: 'text-on-surface-variant animate-pulse' },
  degraded: { icon: 'cloud_off', key: 'common.watchDegraded', cls: 'text-tertiary' },
}
const meta = computed(() => META[props.state])
</script>
<template>
  <span v-if="meta" :class="['inline-flex items-center gap-1 text-xs', meta.cls]">
    <span class="material-symbols-outlined text-sm">{{ meta.icon }}</span>{{ t(meta.key) }}
  </span>
</template>
```

`NsLayers.vue`:

script 区(:23-28 之后加,import 区补 `AsyncState`、`WatchStateChip`):

```js
// watch 聚合态驱动轮询:live/reconnecting 零轮询(watch 推送),降级 60s 兜底(spec §5.4)
const wlState = computed(() => store.watchStateOf('workloads'))
const wlInterval = computed(() => (wlState.value === 'live' || wlState.value === 'reconnecting') ? false : 60000)
```

三条 `useResourceList`(:23-25)的 options 改为:

```js
const wlQ = useResourceList({ key: ['cluster', cid, 'workloads'], fetcher: () => store.fetchWorkloads(), options: { refetchInterval: wlInterval, refetchOnWindowFocus: false } })
const svcQ = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices(), options: { refetchInterval: wlInterval, refetchOnWindowFocus: false } })
const ingQ = useResourceList({ key: ['cluster', cid, 'ingresses'], fetcher: () => store.fetchIngresses(), options: { refetchInterval: wlInterval, refetchOnWindowFocus: false } })
```

再加三态派生:

```js
const booting = computed(() => wlQ.isPending.value && !wlQ.data.value && !svcQ.data.value && !ingQ.data.value)
```

template 区(:94 标题行右侧加 chip;:106 的 `v-if="groups.length"` 外层包 AsyncState):

```html
<!-- 标题行 <p class="text-on-surface-variant ..."> 之后加: -->
<WatchStateChip :state="wlState" />
<!-- :106 起的主区块与 :211 空态改为: -->
<AsyncState :loading="booting" :empty="!items.length">
  <div v-if="groups.length" class="grid grid-cols-1 xl:grid-cols-[220px_1fr_220px] gap-md">
    <!-- ...原 106-208 行内容原样... -->
  </div>
  <div v-else data-test="layers-empty" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant py-md text-center">
    <span class="material-symbols-outlined text-2xl text-surface-container-high">layers</span>
    <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('ns.layers.emptyState') }}</p>
  </div>
</AsyncState>
```

(删掉原独立空态块 :211-214;`details` 体系一览块保留在外。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/WatchStateChip.test.js src/views/__tests__/NsLayers.states.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/composables/useK8sQuery.js src/components/common/WatchStateChip.vue src/components/common/__tests__/WatchStateChip.test.js src/views/NsLayers.vue src/views/__tests__/NsLayers.states.test.js
git commit -m "feat(datalayer): gcTime 永驻+NsLayers 三态(骨架/真空/旧数据)+响应式轮询+WatchStateChip"
```

---

### Task 7: workload 族页面推广响应式轮询 + 残留清扫

**Files:**
- Modify: `src/views/NsWorkloads.vue:38-42`
- Modify: `src/views/NamespaceOverview.vue:37-68`
- Modify: `src/views/NsServiceDetail.vue:40-70`
- Modify: `src/views/NsHPA.vue:30-38`
- Modify: `src/views/NsWorkloadDetail.vue:76-93`
- Modify: `src/views/NsPods.vue`(列表页接 chip,若其 query 有固定 interval 一并响应化)

**Interfaces:**
- Consumes: Task 3 `watchStateOf`、Task 6 `WatchStateChip`/`AsyncState`(AsyncState 已存在)

- [ ] **Step 1: 逐页改造(模式统一,每页同构)**

每页 script 加(变量名按页内既有 key 对齐):

```js
const wlState = computed(() => store.watchStateOf('workloads'))
const wlInterval = computed(() => (wlState.value === 'live' || wlState.value === 'reconnecting') ? false : 60000)
```

各页具体替换:

1. **NsWorkloads.vue:40**:`options: { refetchInterval: 30000 }` → `options: { refetchInterval: wlInterval, refetchOnWindowFocus: false }`
2. **NamespaceOverview.vue:37-43 与 61-68**(三 query 共用 pollInterval):`watch(fastMode, ...)`(:47)改为降级态门控:

```js
watch([fastMode, wlState], ([f, s]) => {
  pollInterval.value = (s === 'live' || s === 'reconnecting') ? false : (f ? FAST_MS : SLOW_MS)
}, { immediate: true })
```

3. **NsServiceDetail.vue:42-44,70**(pods/workloads/events/endpoints 四 query,均 30000):workloads/pods/events 三条换 `wlInterval`(pods 用 `computed(() => store.watchStateOf('pods'))` 同式,events 同式);endpoints 无 watch,保留 30000 但加 `refetchOnWindowFocus: false` 不动其余。
4. **NsHPA.vue:32-36**:workloads query 换 `wlInterval`;hpas 保留 30000。
5. **NsWorkloadDetail.vue:76-93**(pollInterval 已是 ref):`watch(fastMode, ...)`(:93)同 NamespaceOverview 改为 `watch([fastMode, wlState], ...)` 门控;podsQuery 共用 pollInterval(以 workloads 态门控,简化可接受——注释说明)。
6. **NsPods.vue**:检查其 pods query 是否固定 interval,是则按同式接 `watchStateOf('pods')`;列表头加 `<WatchStateChip :state="podsState" />`。

各页标题区(chip 消费):NsWorkloads/NsPods 列表头加 `<WatchStateChip :state="wlState" />`(NsPods 用 pods 态)。

- [ ] **Step 2: 残留清扫**

Run: `grep -rn "refetchInterval: 30000" src/views/ | grep -v __tests__`
Expected 输出仅剩**非 workload 族**资源(endpoints/hpas/pvcs/configmaps/secrets/nodes 等;NsWorkloadDetail:894-896 三条属规格明确的 follow-up,保留)。若出现 workload 族漏网(workloads/services/ingresses/pods/events),逐条改响应式。

- [ ] **Step 3: 全量前端回归**

Run: `npx vitest run`
Expected: 全绿(NamespaceOverview.workload-types 等既有用例若因 interval 断言失败,按「live 态 interval=false」新语义修断言)

- [ ] **Step 4: Commit**

```bash
git add src/views/NsWorkloads.vue src/views/NamespaceOverview.vue src/views/NsServiceDetail.vue src/views/NsHPA.vue src/views/NsWorkloadDetail.vue src/views/NsPods.vue
git commit -m "feat(datalayer): workload 族页面轮询响应化——live 零轮询/降级 60s,fast-poll 仅降级态生效"
```

---

### Task 8: 全量回归 + 构建验证 + 手测清单落档

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-workload-datalayer-cache-watch-design.md`(§7 手测清单标注「待执行」)

**Interfaces:** 无代码接口;产出验证记录。

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: server(scripts/test.mjs + node --test)与 unit(vitest)全绿。

- [ ] **Step 2: 类型/语法与构建**

Run: `npm run typecheck && npm run build && npm run i18n:check`
Expected: 全绿(.vue 改动由 build 覆盖;i18n 双语对齐)。

- [ ] **Step 3: 手测清单(需 kind/真实集群,执行后在规格文档勾选)**

1. NsLayers 离开 >5min 后重访:首帧即内容(旧数据),无空态闪烁
2. 部署向导建 workload → 返回分层页:无空白
3. `kubectl scale deployment` → NsWorkloads/NsLayers 秒级跟变(网络面板无 list 轮询,仅 watch 字节)
4. 停网关 30s:chip 转「重连中」→ 连续失败后「已降级轮询」且 60s 轮询可见 → 重启网关 → 回「实时」
5. watch 断开期间 `kubectl delete pod` → 恢复后(降级轮询或 relist)列表对齐
6. NsWorkloadDetail revisions tab 正常展示;一键回滚到旧 rev 后 spec.template 与该 rev 一致
7. 切换集群:旧集群 watch 全断(网关连接数归零)、缓存清空不串台、新集群 7 条 watch 重建
8. 网络面板确认:list 响应无 managedFields/last-applied-configuration;单对象 GET 仍在(不剥)

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-26-workload-datalayer-cache-watch-design.md
git commit -m "docs(spec): workload 族数据层手测清单标注待执行(实现完成,回归全绿)"
```

---

## Self-Review 记录

- **规格覆盖**:§5.1 缓存→Task 6;§5.2 两刀→Task 1/4/5;§5.3 watch→Task 2/3;§5.4 轮询→Task 6/7;§6 错误处理→Task 2 状态机+Task 8 手测 4/5;§7 测试→各任务 Step 1+Task 8;§2 非目标均未越界(store 10s 定时器/pvcs 等未动)。✓
- **占位符**:无 TBD/TODO;所有代码块完整可落地。✓
- **类型/命名一致性**:`createWatchController`/`watchStateOf`/`fetchWorkloadRevisions(type,name,ns)`/`buildRevisions(deploy,ownedRs)`/`recordListRv(path,rv)` 各任务间签名一致。✓
- 已知简化(有意):NsServiceDetail 的 pods/events 各自聚合态、NsWorkloadDetail pods 共用 workloads 门控、NamespaceOverview 三 query 共用 workloads 门控——watch 各流同传输同生死,聚合粒度粗一级可接受,注释均落点。
