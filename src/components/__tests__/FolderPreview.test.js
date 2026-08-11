import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import FolderPreview from '../common/FolderPreview.vue'

const api = {
  childrenOf: (p) => p === '/app' ? [{ name: 'a.go', type: 'file' }, { name: 'sub', type: 'dir' }] : [],
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
