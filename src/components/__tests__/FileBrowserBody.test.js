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

test('FileBrowserBody: toggleNode 展开→懒加载子并渲染；折叠→不重复 list', async () => {
  // 根有 app(dir)，app 下有 inner.go(file)
  podFileApi.list.mockImplementation(({ path }) => {
    if (path === '/app') return Promise.resolve({ entries: [{ name: 'inner.go', type: 'file' }] })
    return Promise.resolve({ entries: [{ name: 'app', type: 'dir' }] })
  })
  const w = mount(FileBrowserBody, { props: { namespace: 'ns', pod: 'p', container: 'c' }, global: { plugins: [i18n] } })
  await flushPromises()
  // 根加载（1 次 list '/'）
  expect(podFileApi.list).toHaveBeenCalledWith(expect.objectContaining({ container: 'c', path: '/' }))
  // app 折叠态：尚未 list /app
  expect(podFileApi.list).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/app' }))

  // 找到 app 行的 twisty 并点击展开
  const rows = w.findAll('.fb-row')
  const appRow = rows.filter(r => r.text().includes('app'))[0]
  const twisty = appRow.find('.fb-twisty')
  expect(twisty.exists()).toBe(true)
  await twisty.trigger('click')
  await flushPromises()

  // 展开 → list /app 被调用 + 子节点 inner.go 渲染
  expect(podFileApi.list).toHaveBeenCalledWith(expect.objectContaining({ container: 'c', path: '/app' }))
  expect(w.text()).toContain('inner.go')

  // 记录当前 list 调用数，再折叠，断言不再增加
  const callsBeforeCollapse = podFileApi.list.mock.calls.length
  await twisty.trigger('click')
  await flushPromises()
  expect(podFileApi.list.mock.calls.length).toBe(callsBeforeCollapse) // 折叠不重拉
})

test('FileBrowserBody: 切换 container 触发 reset + 以新容器重拉根', async () => {
  podFileApi.list.mockResolvedValue({ entries: [{ name: 'readme.md', type: 'file' }] })
  const w = mount(FileBrowserBody, { props: { namespace: 'ns', pod: 'p', container: 'c' }, global: { plugins: [i18n] } })
  await flushPromises()
  // 初始挂载已用 container:'c' list '/'
  expect(podFileApi.list).toHaveBeenCalledWith(expect.objectContaining({ container: 'c', path: '/' }))

  // 切容器
  await w.setProps({ container: 'c2' })
  await flushPromises()

  // watch(container) 触发 resetForContainer + 重拉根(新容器 c2)
  expect(podFileApi.list).toHaveBeenCalledWith(expect.objectContaining({ container: 'c2', path: '/' }))
})

test('FileBrowserBody: onUpload 写入选中文件夹并强制刷新该目录', async () => {
  // 根有 app(dir)，app 下有 inner.go(file)
  podFileApi.list.mockImplementation(({ path }) => {
    if (path === '/app') return Promise.resolve({ entries: [{ name: 'inner.go', type: 'file' }] })
    return Promise.resolve({ entries: [{ name: 'app', type: 'dir' }] })
  })
  podFileApi.write.mockResolvedValue({ ok: true })

  const w = mount(FileBrowserBody, { props: { namespace: 'ns', pod: 'p', container: 'c' }, global: { plugins: [i18n] } })
  await flushPromises()

  // 先展开 app(让 /app 进缓存)，这样后续上传后的 list 必然是 force 覆盖缓存而非首次懒加载
  const appRow0 = w.findAll('.fb-row').filter(r => r.text().includes('app'))[0]
  await appRow0.find('.fb-twisty').trigger('click')
  await flushPromises()
  const listCallsBeforeUpload = podFileApi.list.mock.calls.length // 此时已 list '/' + '/app'

  // 选中 app 文件夹（点行触发 selectNode('/app', true)）
  await appRow0.trigger('click')
  await flushPromises()

  // 通过 input change 触发 onUpload：写入 /app/up.txt
  const input = w.find('input[type=file]')
  const file = new File(['x'], 'up.txt')
  // happy-dom 下 .files 只读，用 defineProperty 强制覆盖
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true, writable: true })
  Object.defineProperty(input.element, 'value', { value: '', configurable: true, writable: true })
  await input.trigger('change')
  await flushPromises()

  // 写入路径 = 选中目录 + 文件名
  expect(podFileApi.write).toHaveBeenCalledWith(expect.objectContaining({ container: 'c', path: '/app/up.txt' }))
  // 写完后强制刷新该目录：/app 已缓存却仍被 list(force 在 listDir 层覆盖缓存，故 list 调用数 +1)
  expect(podFileApi.list.mock.calls.length).toBe(listCallsBeforeUpload + 1)
  expect(podFileApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ container: 'c', path: '/app' }))
})
