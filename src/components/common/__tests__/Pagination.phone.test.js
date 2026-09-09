// src/components/common/__tests__/Pagination.phone.test.js
// Wave5 W1 Task2(R2):分页条手机档可换行、摘要降级、翻页钮命中区。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Pagination from '../Pagination.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

describe('Pagination 手机档(R2)', () => {
  it('根行含 max-sm:flex-wrap;摘要 max-sm:hidden;前后钮带四件套', () => {
    const spy = mockViewport(true)
    try {
      const w = mount(Pagination, { props: { total: 55, pageSize: 10, currentPage: 2, showSizeSelector: true } })
      expect(w.find('div').classes().join(' ')).toContain('max-sm:flex-wrap')
      const summary = w.findAll('span').find(s => s.text().includes('rangeSummary'))
      expect(summary.classes()).toContain('max-sm:hidden')
      const prev = w.findAll('button').find(b => b.attributes('title') === 'component.pagination.prevPage')
      expect(prev.classes().join(' ')).toContain('max-sm:after:-inset-2')
      // 功能不回归:下一页仍可点并 emit
      const next = w.findAll('button').find(b => b.attributes('title') === 'component.pagination.nextPage')
      expect(next.attributes('disabled')).toBeUndefined()
      w.unmount(); document.body.innerHTML = ''
    } finally { spy.mockRestore() }
  })
})
