import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import FolderPreview from '../common/FolderPreview.vue'

const api = {
  childrenOf: (p) => p === '/app' ? [{ name: 'a.go', type: 'file' }, { name: 'sub', type: 'dir' }] : [],
  listDir: vi.fn().mockResolvedValue([]),
  isLoading: () => false,
  selectNode: vi.fn(),
}
const mountWith = (props) => mount(FolderPreview, { props, global: { plugins: [i18n], provide: { fileExplorer: api } } })

test('FolderPreview: 列条目 + 点文件触发 selectNode', async () => {
  const w = mountWith({ path: '/app' })
  expect(w.text()).toContain('a.go')
  expect(w.text()).toContain('sub')
  const rows = w.findAll('button.fb-item')
  await rows[0].trigger('click')
  expect(api.selectNode).toHaveBeenCalledWith('/app/a.go', false)
})

test('FolderPreview: 空目录文案', () => {
  const w = mountWith({ path: '/empty' })
  expect(w.text()).toContain('空目录') // t('component.fileBrowser.emptyDir') 的 zh 译文
})

test('FolderPreview: 选中未缓存目录 → 触发 listDir 并渲染其条目', async () => {
  // 复现 bug:选中一个未在树里展开过(未缓存)的目录,FolderPreview 必须自己加载内容
  const store = {}
  const stateful = {
    childrenOf: (p) => store[p] || [],
    isLoading: () => false,
    listDir: vi.fn().mockImplementation(async (p) => { store[p] = [{ name: 'inner.go', type: 'file' }]; return store[p] }),
    selectNode: vi.fn(),
  }
  const w = mount(FolderPreview, { props: { path: '/fresh' }, global: { plugins: [i18n], provide: { fileExplorer: stateful } } })
  expect(stateful.listDir).toHaveBeenCalledWith('/fresh')   // 选中即触发加载
  await flushPromises()
  expect(w.text()).toContain('inner.go')                     // 加载后渲染条目(而非"空目录")
})
