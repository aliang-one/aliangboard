// VueFlow 在 happy-dom 的可挂载性冒烟(2026-09-01 拓扑连线化 Task 1)。
// vue-flow 依赖 ResizeObserver/尺寸测量——setup.js 提供 stub;本测试锁该前提,
// 在任何拓扑重写工作开始前 fail-fast。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { markRaw, defineComponent, h } from 'vue'
import { VueFlow, Handle, Position } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import { i18n } from '@/i18n'

const Mini = defineComponent({
  setup() {
    return () => h('div', { class: 'mini-node' }, [
      h(Handle, { type: 'target', position: Position.Left }),
      h('span', null, 'mini'),
      h(Handle, { type: 'source', position: Position.Right }),
    ])
  },
})

test('VueFlow + 自定义节点可在 happy-dom 挂载并渲染节点 DOM', async () => {
  const w = mount(VueFlow, {
    props: {
      nodes: [{ id: 'n1', type: 'mini', position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n1', type: 'smoothstep' }],
      nodeTypes: { mini: markRaw(Mini) },
      fitViewOnInit: false, zoomOnScroll: false, nodesDraggable: false,
    },
    global: { plugins: [i18n] },
  })
  await flush()
  expect(w.find('.vue-flow').exists()).toBe(true, 'VueFlow 根容器渲染')
  expect(w.find('.mini-node').exists()).toBe(true, '自定义节点渲染')
  expect(w.find('.mini-node').text()).toContain('mini')
})

function flush() { return new Promise(r => setTimeout(r, 0)) }
