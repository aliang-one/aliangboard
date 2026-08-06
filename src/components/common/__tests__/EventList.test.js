import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EventList from '../EventList.vue'

const ev = (over = {}) => ({
  type: 'normal', reason: 'Started', message: 'Container started', time: '12s',
  icon: 'play_circle', color: 'primary', relatedKind: '', relatedName: '', ...over,
})

describe('EventList', () => {
  it('full mode renders reason, time, message', () => {
    const w = mount(EventList, { props: { events: [ev({ reason: 'Pulled', message: 'Image pulled' })] } })
    expect(w.text()).toContain('Pulled')
    expect(w.text()).toContain('Image pulled')
    expect(w.text()).toContain('12s')
  })
  it('compact mode renders reason + time but not message', () => {
    const w = mount(EventList, { props: { events: [ev({ message: 'secret' })], compact: true } })
    expect(w.text()).toContain('Started')
    expect(w.text()).not.toContain('secret')
  })
  it('max truncates the list', () => {
    const w = mount(EventList, { props: { events: [ev({ reason: 'a' }), ev({ reason: 'b' }), ev({ reason: 'zz-truncated' })], max: 2, compact: true } })
    expect(w.text()).toContain('a')
    expect(w.text()).toContain('b')
    expect(w.text()).not.toContain('zz-truncated') // 第三个事件被截断
  })
  it('emits navigate on full-mode related row click', async () => {
    const w = mount(EventList, { props: { events: [ev({ relatedKind: 'Pod', relatedName: 'web' })] } })
    await w.find('[data-testid="event-row"]').trigger('click')
    expect(w.emitted('navigate')).toBeTruthy()
    expect(w.emitted('navigate')[0][0].relatedKind).toBe('Pod')
  })
})
