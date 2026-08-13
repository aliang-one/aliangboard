import { test, expect, vi } from 'vitest'
import { reactive } from 'vue'

// 用 reactive 对象模拟 vue-router 的 useRoute() 返回值(真实 route 也是 reactive),
// 这样 computed 能在跨用例改 meta 时重新求值。
const { routeRef } = vi.hoisted(() => {
  const { reactive: _reactive } = require('vue')
  return {
    routeRef: _reactive({ meta: { scope: 'global' }, path: '/cluster', params: {} }),
  }
})

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: () => {} }),
}))

import { useNavMode } from '../useNavMode'

test('scope=global → cluster mode', () => {
  routeRef.meta.scope = 'global'
  const { navMode, isNsMode, isClusterMode } = useNavMode()
  expect(navMode.value).toBe('cluster')
  expect(isClusterMode.value).toBe(true)
  expect(isNsMode.value).toBe(false)
})

test('scope=namespace → namespace mode', () => {
  routeRef.meta.scope = 'namespace'
  const { navMode, isNsMode, isClusterMode } = useNavMode()
  expect(navMode.value).toBe('namespace')
  expect(isNsMode.value).toBe(true)
  expect(isClusterMode.value).toBe(false)
})

test('missing scope meta → cluster mode (default)', () => {
  routeRef.meta = {}
  const { navMode, isClusterMode } = useNavMode()
  expect(navMode.value).toBe('cluster')
  expect(isClusterMode.value).toBe(true)
})
