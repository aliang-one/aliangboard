// src/components/layout/__tests__/TopNavBar.test.js
// issue #3 顶栏溢出回归:整行可收缩链(搜索框优先缩)+ 名字截断后 title 兜底。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/cluster' }), useRouter: () => ({ push: vi.fn() }) }))

import TopNavBar from '@/components/layout/TopNavBar.vue'
import { useClusterStore } from '@/stores/cluster'

function mountNav() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(TopNavBar, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}

test('收缩链:搜索框包裹层 min-w-0,集群/ns 按钮包裹层 shrink-0', () => {
  setActivePinia(createPinia())
  const w = mountNav()
  const searchWrap = w.find('header div.max-w-xs')
  expect(searchWrap.classes()).toContain('min-w-0')
  const clusterWrap = searchWrap.element.nextElementSibling
  expect(clusterWrap.className).toContain('shrink-0')
  const nsWrap = clusterWrap.nextElementSibling
  expect(nsWrap.className).toContain('shrink-0')
})

test('集群名截断后 title 可见全名;用户名 span truncate+max-w', () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useClusterStore()
  const longName = 'a-very-long-cluster-name-that-exceeds-180px-for-sure'
  store.savedClusters = [{ name: longName, apiServer: 'https://k8s.example', version: 'v1.31', distribution: 'k3s' }]
  store.currentCluster = longName
  const w = mountNav()
  const clusterBtn = w.findAll('header button').find(b => b.text().includes('CLUSTER'))
  const nameSpan = clusterBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(nameSpan.attributes('title')).toBe(longName)
  const logoutBtn = w.findAll('header button').at(-1)
  const userSpan = logoutBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(userSpan.classes()).toContain('xl:max-w-[120px]')
})

test('紧凑档:集群/命名空间标签行 <xl 隐藏,值宽三级收缩', () => {
  setActivePinia(createPinia())
  const w = mountNav()
  expect(w.html()).toContain('hidden xl:block')       // CLUSTER/NAMESPACE 标签行
  expect(w.html()).toContain('max-w-[80px] lg:max-w-[110px]')
})
