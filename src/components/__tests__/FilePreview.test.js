import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import FilePreview from '../common/FilePreview.vue'

vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
import { notify } from '@/composables/useToast'
vi.mock('@/api/client', () => ({ podFileApi: { downloadStream: vi.fn() } }))
import { podFileApi } from '@/api/client'

function api(file) {
  return {
    readFile: vi.fn().mockResolvedValue(file),
    writeFile: vi.fn().mockResolvedValue(),
    ctx: { value: { namespace: 'ns', pod: 'p', container: '' } },   // FileBrowserBody provide 的 computed ctx
  }
}

beforeEach(() => { notify.mockReset(); podFileApi.downloadStream.mockReset(); setActivePinia(createPinia()) })

test('FilePreview: 查看态渲染 CodeViewer（含内容）', async () => {
  const w = mount(FilePreview, {
    props: { path: '/a.go' },
    global: { plugins: [i18n], provide: { fileExplorer: api({ name: 'a.go', path: '/a.go', content: 'package main', truncated: false, binary: false }) } },
  })
  await flushPromises()
  expect(w.text()).toContain('package main')
  expect(w.find('pre').exists()).toBe(true)
})

test('FilePreview: 编辑→保存触发 writeFile', async () => {
  const a = api({ name: 'a.go', path: '/a.go', content: 'old', truncated: false, binary: false })
  const w = mount(FilePreview, { props: { path: '/a.go' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  await w.find('button.fb-edit').trigger('click')
  expect(w.find('textarea').exists()).toBe(true)
  await w.find('textarea').setValue('new content')
  await w.find('button.fb-save').trigger('click')
  await flushPromises()
  expect(a.writeFile).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalled()
})

test('FilePreview: 二进制→占位 + 下载按钮', async () => {
  const a = api({ name: 'a.bin', path: '/a.bin', content: '', truncated: false, binary: true })
  const w = mount(FilePreview, { props: { path: '/a.bin' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  expect(w.text()).toContain('二进制') // t('...binary')/binaryHint 的 zh 关键词
  expect(w.find('textarea').exists()).toBe(false)
})

test('FilePreview: 截断→显示提示', async () => {
  const a = api({ name: 'big.log', path: '/big.log', content: 'x'.repeat(10), truncated: true, binary: false })
  const w = mount(FilePreview, { props: { path: '/big.log' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  expect(w.text()).toContain('截断') // t('...truncated') 的 zh 关键词
})

test('FilePreview: 下载按钮 → transfers store 流式下载(带 ctx)', async () => {
  podFileApi.downloadStream.mockResolvedValue(new Blob(['x']))
  const a = api({ name: 'a.bin', path: '/a.bin', content: '', truncated: false, binary: true })
  const w = mount(FilePreview, { props: { path: '/a.bin' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  await w.find('button[title="下载"]').trigger('click')
  expect(podFileApi.downloadStream).toHaveBeenCalledWith(
    { namespace: 'ns', pod: 'p', container: '', path: '/a.bin' },
    expect.objectContaining({ onProgress: expect.any(Function) }),
  )
})
