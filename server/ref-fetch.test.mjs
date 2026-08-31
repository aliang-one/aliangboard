// ref-fetch 单测(2026-08-31 工具链审计修复⑤):fetchRefContext 从 index.mjs 抽出
// (deps 注入,原 T5 内联实现搬迁);超时与 not found 分流——此前慢集群(>5s)被统一
// 标「not found / 已删除」,LLM 会把超时误读成资源已删,可能据此给错误诊断。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createRefContextFetcher, withTimeout } from './ref-fetch.mjs'

test('withTimeout:超时输家的 Error 带 isTimeout 标记(供失败分流)', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, 'ref Pod/x'),
    e => e.isTimeout === true && /超时/.test(e.message),
  )
})

test('K8s ref 拉取成功 → REFS_CTX_HEADER + JSON 块(原语义保留)', async () => {
  const fetcher = createRefContextFetcher({
    requestKubernetes: async () => ({ status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: 'nginx' } } }),
    listSshServers: () => [],
  })
  const out = await fetcher.fetchRefContext([{ kind: 'pod', namespace: 'default', name: 'nginx' }], {})
  assert.ok(out.startsWith('\n\nReferenced resources'))
  assert.match(out, /\[pod\/default\/nginx\]/)
  assert.match(out, /"nginx"/)
})

test('修复⑤:拉取超时 → 标「查询超时,状态未知」,不再误报 not found/已删除', async () => {
  const fetcher = createRefContextFetcher({
    requestKubernetes: () => new Promise(() => {}), // 慢集群:永不返回
    listSshServers: () => [],
    refTimeoutMs: 30,
  })
  const out = await fetcher.fetchRefContext([{ kind: 'pod', namespace: 'default', name: 'slow' }], {})
  assert.match(out, /查询超时/)
  assert.equal(out.includes('not found'), false, '超时不得标成 not found / 已删除')
})

test('404 → (not found / 已删除) 漂移感知语义保留', async () => {
  const e = new Error('pods "ghost" not found'); e.status = 404
  const fetcher = createRefContextFetcher({
    requestKubernetes: async () => { throw e },
    listSshServers: () => [],
  })
  const out = await fetcher.fetchRefContext([{ kind: 'pod', namespace: 'default', name: 'ghost' }], {})
  assert.match(out, /not found \/ 已删除/)
})

test('@server 引用与无集群 guard 保留(server 不触 K8s;K8s ref 无集群逐条标注)', async () => {
  const fetcher = createRefContextFetcher({
    requestKubernetes: async () => { throw new Error('不应触网') },
    listSshServers: () => [{ id: 'a', name: 'gw-1', description: '入口网关', clusterRef: '' }],
  })
  const serverOut = await fetcher.fetchRefContext([{ kind: 'server', namespace: '', name: 'gw-1' }], null)
  assert.match(serverOut, /gw-1/)
  const noCluster = await fetcher.fetchRefContext([{ kind: 'pod', namespace: 'd', name: 'x' }], null)
  assert.match(noCluster, /无集群/)
})

test('无 references → 空串(原短路保留)', async () => {
  const fetcher = createRefContextFetcher({ requestKubernetes: async () => { throw new Error('x') }, listSshServers: () => [] })
  assert.equal(await fetcher.fetchRefContext([], {}), '')
  assert.equal(await fetcher.fetchRefContext(null, {}), '')
})
