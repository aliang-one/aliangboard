import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import FilePreview from '../common/FilePreview.vue'

vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
import { notify } from '@/composables/useToast'

function api(file) {
  return {
    readFile: vi.fn().mockResolvedValue(file),
    writeFile: vi.fn().mockResolvedValue(),
    download: vi.fn().mockResolvedValue(new Blob(['x'])),
  }
}

beforeEach(() => notify.mockReset())

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
