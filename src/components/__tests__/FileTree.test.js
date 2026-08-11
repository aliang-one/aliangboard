import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import FileTree from '../common/FileTree.vue'
import FileTreeNode from '../common/FileTreeNode.vue'

// 组件模板用 $t(...) 渲染 aria-label / 空目录文案；happy-dom 下须安装 i18n 插件，
// 否则 _ctx.$t is not a function（仓库既有模式见 _allComponentsMount.test.js）。

// 构造 inject 桩
function stubApi(over = {}) {
  return {
    ctx: { namespace: 'ns', pod: 'p', container: 'c' },
    selected: { value: null },
    isExpanded: () => false,
    isLoading: () => false,
    childrenOf: (p) => p === '/' ? [{ name: 'app', type: 'dir' }, { name: 'a.go', type: 'file' }] : [{ name: 'inner.go', type: 'file' }],
    selectNode: vi.fn(),
    toggleNode: vi.fn().mockResolvedValue(),
    ...over,
  }
}

test('FileTree: 渲染根条目', () => {
  const w = mount(FileTree, { global: { plugins: [i18n], provide: { fileExplorer: stubApi() } } })
  expect(w.text()).toContain('app')
  expect(w.text()).toContain('a.go')
})

test('FileTreeNode: 点文件行触发 selectNode(file)', async () => {
  const api = stubApi()
  const w = mount(FileTreeNode, {
    props: { entry: { name: 'a.go', type: 'file' }, parentPath: '/', depth: 0 },
    global: { plugins: [i18n], provide: { fileExplorer: api } },
  })
  await w.find('.fb-row').trigger('click')
  expect(api.selectNode).toHaveBeenCalledWith('/a.go', false)
})

test('FileTreeNode: 点 twisty 触发 toggleNode；展开后渲染子节点', async () => {
  const api = stubApi({ isExpanded: (p) => p === '/app' })
  const w = mount(FileTreeNode, {
    props: { entry: { name: 'app', type: 'dir' }, parentPath: '/', depth: 0 },
    global: { plugins: [i18n], provide: { fileExplorer: api } },
  })
  await w.find('.fb-twisty').trigger('click')
  expect(api.toggleNode).toHaveBeenCalledWith('/app')
  expect(w.text()).toContain('inner.go') // 展开后递归渲染子节点
})

test('FileTreeNode: 选中态高亮 class', () => {
  const api = stubApi({ selected: { value: '/a.go' } })
  const w = mount(FileTreeNode, {
    props: { entry: { name: 'a.go', type: 'file' }, parentPath: '/', depth: 0 },
    global: { plugins: [i18n], provide: { fileExplorer: api } },
  })
  expect(w.find('.fb-row').classes()).toContain('fb-selected')
})
