// SshFileBrowserBody 契约(Task 14):
// ① 挂载即 sshFileApi.list(serverId, '/')
// ② 点击目录项 → list(serverId, 新路径)
// ③ 文件行「下载」→ downloadStream({serverId, path}, { onProgress }) 且 onProgress 透传驱动进度
// ④ 底部上传 input change → uploadStream({serverId, path, name}, file, { onProgress })
// mock 策略照 SshTerminal.test.js 的 vi.hoisted 流派。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => ({ list: [], download: [], upload: [] }))
vi.mock('@/api/client', () => ({
  sshFileApi: {
    list: vi.fn(async (serverId, path) => {
      calls.list.push({ serverId, path })
      if (path === '/var') return { path: '/var', entries: [{ name: 'log', type: 'dir' }, { name: 'a.txt', type: 'file' }] }
      return { path, entries: [{ name: 'var', type: 'dir' }, { name: 'etc', type: 'dir' }, { name: 'root.txt', type: 'file' }] }
    }),
    downloadStream: vi.fn(async (payload, opts = {}) => {
      calls.download.push({ payload, hasProgress: typeof opts.onProgress === 'function' })
      opts.onProgress?.({ received: 5, total: 10 })
      return new Blob(['x'], { type: 'application/octet-stream' })
    }),
    uploadStream: vi.fn(async (payload, file, opts = {}) => {
      calls.upload.push({ payload, fileName: file?.name, hasProgress: typeof opts.onProgress === 'function' })
      opts.onProgress?.({ received: 3, total: 3 })
      return { ok: true, bytes: 3 }
    }),
  },
}))

import SshFileBrowserBody from '../SshFileBrowserBody.vue'

const mountBody = () => mount(SshFileBrowserBody, {
  props: { serverId: 'sv1', serverName: 'web-1' },
  global: { plugins: [i18n] },
})
beforeEach(() => { calls.list.length = 0; calls.download.length = 0; calls.upload.length = 0 })

test('挂载即 list 根目录;点击目录项进入子目录再 list', async () => {
  const w = mountBody()
  await flushPromises()
  expect(calls.list[0]).toEqual({ serverId: 'sv1', path: '/' })
  expect(w.text()).toContain('root.txt')
  // 点击目录行(名字含 var 的 dir 行)→ list('/var')
  await w.findAll('[data-test="dirRow"]').find(r => r.text().includes('var')).trigger('click')
  await flushPromises()
  expect(calls.list.at(-1)).toEqual({ serverId: 'sv1', path: '/var' })
  expect(w.text()).toContain('a.txt')
})

test('点击文件「下载」→ downloadStream 透传 onProgress 且进度渲染', async () => {
  const w = mountBody()
  await flushPromises()
  const btn = w.findAll('[data-test="btnDownload"]').find(b => true)
  await btn.trigger('click')
  await flushPromises()
  expect(calls.download.length).toBe(1)
  expect(calls.download[0].payload).toEqual({ serverId: 'sv1', path: '/root.txt' })
  expect(calls.download[0].hasProgress).toBe(true)
  // 进度条出现且显示 50%
  expect(w.find('[data-test="progress"]').exists()).toBe(true)
  expect(w.text()).toContain('50%')
})

test('上传 input change → uploadStream 带文件名与 onProgress;完成后刷新目录', async () => {
  const w = mountBody()
  await flushPromises()
  const input = w.find('input[type="file"]')
  const f = new File(['abc'], 'note.txt', { type: 'text/plain' })
  Object.defineProperty(input.element, 'files', { value: [f] })
  await input.trigger('change')
  await flushPromises()
  expect(calls.upload.length).toBe(1)
  expect(calls.upload[0].payload).toEqual({ serverId: 'sv1', path: '/', name: 'note.txt' })
  expect(calls.upload[0].fileName).toBe('note.txt')
  expect(calls.upload[0].hasProgress).toBe(true)
  // 上传完成 → 强制重拉当前目录
  expect(calls.list.length).toBeGreaterThanOrEqual(2)
})

test('非法文件名(含 /) 客户端拦截,不发起上传', async () => {
  const w = mountBody()
  await flushPromises()
  const input = w.find('input[type="file"]')
  const f = new File(['abc'], 'a/b.txt')
  Object.defineProperty(f, 'name', { value: 'a/b.txt' })
  Object.defineProperty(input.element, 'files', { value: [f] })
  await input.trigger('change')
  await flushPromises()
  expect(calls.upload.length).toBe(0)
  expect(w.find('[data-test="error"]').exists()).toBe(true)
})
