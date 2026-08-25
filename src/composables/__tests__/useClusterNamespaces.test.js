// useClusterNamespaces:按 clusterId 拉 ns 候选。失败清空不残留;空 id 直清;慢旧响应不得覆盖新结果。
import { test, expect } from 'vitest'
import { useClusterNamespaces } from '@/composables/useClusterNamespaces'

test('成功:list 填响应;loading 先真后假', async () => {
  const fetchNs = async () => ({ namespaces: ['default', 'kube-system'] })
  const { list, loading, error, load } = useClusterNamespaces(fetchNs)
  const p = load('c1')
  expect(loading.value).toBe(true)
  await p
  expect(list.value).toEqual(['default', 'kube-system'])
  expect(loading.value).toBe(false)
  expect(error.value).toBeNull()
})

test('失败:清空 list(不残留上一集群候选)+ error 填错', async () => {
  const fetchNs = async id => id === 'bad' ? Promise.reject(new Error('boom')) : { namespaces: ['a'] }
  const { list, error, load } = useClusterNamespaces(fetchNs)
  await load('c1'); expect(list.value).toEqual(['a'])
  await load('bad')
  expect(list.value).toEqual([])
  expect(error.value.message).toBe('boom')
})

test('空 clusterId:清空态不残留,且不发请求', async () => {
  const calls = []
  const fetchNs = async id => { calls.push(id); return { namespaces: [id] } }
  const { list, error, load } = useClusterNamespaces(fetchNs)
  await load('c1')
  expect(list.value).toEqual(['c1'])
  await load('')
  expect(list.value).toEqual([]); expect(error.value).toBeNull()
  expect(calls).toEqual(['c1'])   // 空 id 没有再发
})

test('竞态守卫:c1 慢响应晚于 c2 完成 → 保留 c2 结果', async () => {
  let resolveSlow
  const fetchNs = id => id === 'slow' ? new Promise(r => { resolveSlow = () => r({ namespaces: ['slow-ns'] }) }) : Promise.resolve({ namespaces: ['fast-ns'] })
  const { list, load } = useClusterNamespaces(fetchNs)
  const p1 = load('slow')
  const p2 = load('fast')
  await p2
  resolveSlow(); await p1
  expect(list.value).toEqual(['fast-ns'])
})
