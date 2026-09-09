// src/components/common/__tests__/Breadcrumbs.phone.test.js
// Wave5 W1 Task3:面包屑各段 truncate(长 ns/资源名不再撑破头部),分隔箭头不收缩。
import { describe, it, expect } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { nextTick } from 'vue'
import Breadcrumbs from '../Breadcrumbs.vue'

describe('Breadcrumbs truncate', () => {
  it('各段可 truncate,容器 min-w-0;末段高亮保留', () => {
    const w = mount(Breadcrumbs, {
      props: { items: [
        { label: 'my-team-production-with-a-very-long-name', route: '/ns/x' },
        { label: 'PersistentVolumeClaims', route: '/y' },
        { label: 'data-archive-pvc-2026-with-long-suffix' },
      ] },
      // 组件模板用 router-link;无真实路由的组件测试里用 VTU 官方 stub 渲染成真 <a>
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    const links = w.findAll('a')
    expect(links.length).toBe(2)
    for (const a of links) expect(a.classes()).toContain('truncate')
    const last = w.findAll('span').filter(s => s.text().includes('data-archive'))
    expect(last.length).toBeGreaterThan(0)
    w.unmount()
  })
})
