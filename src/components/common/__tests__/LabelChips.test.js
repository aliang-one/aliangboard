import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LabelChips from '../LabelChips.vue'

describe('LabelChips', () => {
  it('renders one chip per label as "key: val"', () => {
    const w = mount(LabelChips, { props: { labels: { app: 'web', tier: 'frontend' } } })
    expect(w.text()).toContain('app: web')
    expect(w.text()).toContain('tier: frontend')
    expect(w.findAll('span').length).toBeGreaterThanOrEqual(2)
  })
  it('uses the canonical chip classes', () => {
    const w = mount(LabelChips, { props: { labels: { a: 'b' } } })
    expect(w.find('span').classes()).toContain('bg-surface-container')
    expect(w.find('span').classes()).toContain('rounded')
  })
  it('shows emptyText when labels is empty', () => {
    const w = mount(LabelChips, { props: { labels: {}, emptyText: '无标签' } })
    expect(w.text()).toContain('无标签')
  })
  it('renders nothing extra when empty and no emptyText', () => {
    const w = mount(LabelChips, { props: { labels: {} } })
    expect(w.findAll('span').length).toBe(0)
  })
})
