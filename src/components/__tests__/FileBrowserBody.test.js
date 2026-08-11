import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  podFileApi: {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    download: vi.fn(),
  },
}))
import { podFileApi } from '@/api/client'
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

let _ls
beforeEach(() => {
  _ls = globalThis.localStorage
  const mem = new Map()
  globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), clear: () => mem.clear() }
  podFileApi.list.mockReset(); podFileApi.read.mockReset(); podFileApi.write.mockReset(); podFileApi.download.mockReset()
})
afterEach(() => { if (_ls) globalThis.localStorage = _ls })
import FileBrowserBody from '../common/FileBrowserBody.vue'

test('FileBrowserBody: 挂载加载根；点文件→FilePreview；点文件夹→FolderPreview', async () => {
  podFileApi.list.mockResolvedValue({ entries: [{ name: 'app', type: 'dir' }, { name: 'readme.md', type: 'file' }] })
  podFileApi.read.mockResolvedValue({ path: '/readme.md', content: '# hi', truncated: false, binary: false })
  const w = mount(FileBrowserBody, { props: { namespace: 'ns', pod: 'p', container: 'c' }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.text()).toContain('app')
  expect(w.text()).toContain('readme.md')
  // 点文件
  const fileRow = w.findAll('.fb-row').filter(r => r.text().includes('readme.md'))[0]
  await fileRow.trigger('click')
  await flushPromises()
  expect(podFileApi.read).toHaveBeenCalledWith(expect.objectContaining({ path: '/readme.md' }))
  // 点文件夹
  const dirRow = w.findAll('.fb-row').filter(r => r.text().includes('app'))[0]
  await dirRow.trigger('click')
  await flushPromises()
  expect(w.text()).toContain('app') // FolderPreview 头部仍含路径
})
