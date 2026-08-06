import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AnnotationList from '../AnnotationList.vue'

describe('AnnotationList', () => {
  it('renders one row per annotation as key: "val"', () => {
    const w = mount(AnnotationList, { props: { annotations: { 'kubectl.kubernetes.io/last-applied': '{"a":1}' } } })
    expect(w.text()).toContain('kubectl.kubernetes.io/last-applied: "{"a":1}"')
  })
  it('uses the canonical mono container classes', () => {
    const w = mount(AnnotationList, { props: { annotations: { a: 'b' } } })
    const box = w.findAll('div').find(d => d.classes().includes('font-mono'))
    expect(box?.classes()).toContain('bg-surface-container')
  })
  it('shows emptyText when annotations is empty', () => {
    const w = mount(AnnotationList, { props: { annotations: {}, emptyText: '无注解' } })
    expect(w.text()).toContain('无注解')
  })
})
