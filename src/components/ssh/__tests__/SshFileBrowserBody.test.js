// SshFileBrowserBody 契约(Task 14 + 两阶段进度修复):
// ① 挂载即 sshFileApi.list(serverId, '/')
// ② 点击目录项 → list(serverId, 新路径)
// ③ 文件行「下载」→ downloadStream({serverId, path}, { onProgress }) 且 onProgress 透传驱动进度
// ④ 底部上传 input change → uploadStream({serverId, path, name}, file, { onProgress })
// ⑤ 两阶段进度(XHR 100% ≠ 端到端完成):上传字节发满而响应未回 → 封顶 99% + 「写入服务器中」提示;
//    resolve 后 → 100% + ✓ 完成态,约 4s 自动收起;下载不经网关中继语义,不封顶。
// mock 策略照 SshTerminal.test.js 的 vi.hoisted 流派;uploadImpl/downloadImpl 为单测可控的挂起闸门。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => ({ list: [], download: [], upload: [], uploadImpl: null, downloadImpl: null }))
vi.mock('@/api/client', () => ({
  sshFileApi: {
    list: vi.fn(async (serverId, path) => {
      calls.list.push({ serverId, path })
      if (path === '/var') return { path: '/var', entries: [{ name: 'log', type: 'dir' }, { name: 'a.txt', type: 'file' }] }
      return { path, entries: [{ name: 'var', type: 'dir' }, { name: 'etc', type: 'dir' }, { name: 'root.txt', type: 'file' }] }
    }),
    downloadStream: vi.fn(async (payload, opts = {}) => {
      calls.download.push({ payload, hasProgress: typeof opts.onProgress === 'function' })
      if (calls.downloadImpl) return calls.downloadImpl(opts)
      opts.onProgress?.({ received: 5, total: 10 })
      return new Blob(['x'], { type: 'application/octet-stream' })
    }),
    uploadStream: vi.fn(async (payload, file, opts = {}) => {
      calls.upload.push({ payload, fileName: file?.name, hasProgress: typeof opts.onProgress === 'function' })
      if (calls.uploadImpl) return calls.uploadImpl(opts)
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
beforeEach(() => { calls.list.length = 0; calls.download.length = 0; calls.upload.length = 0; calls.uploadImpl = null; calls.downloadImpl = null })

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

// —— 两阶段进度(XHR 100% ≠ 端到端完成,2026-09-04 事故修复)——

async function uploadWith(w, name) {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [new File(['abc'], name)], configurable: true })   // configurable:同一元素可重复定义(连发两笔)
  await input.trigger('change')
}

test('上传已发满但响应未回 → 封顶 99% + 「写入服务器中」提示,不得显示 100%', async () => {
  const w = mountBody()
  await flushPromises()
  calls.uploadImpl = (opts) => new Promise(() => { opts.onProgress?.({ received: 3, total: 3 }) })   // 恒挂起:网关→服务器中继段
  await uploadWith(w, 'big.bin')
  await flushPromises()
  expect(w.find('[data-test="progress"]').exists()).toBe(true)
  expect(w.text()).toContain('99%')
  expect(w.text()).not.toContain('100%')
  expect(w.find('[data-test="relayHint"]').exists()).toBe(true)
  expect(w.text()).not.toContain('ssh.uploadWriting')   // i18n 键已登记(缺键 vue-i18n 会原样吐键名)
})

test('上传未发满 → 显示真实百分比,不出现写入提示', async () => {
  const w = mountBody()
  await flushPromises()
  calls.uploadImpl = (opts) => new Promise(() => { opts.onProgress?.({ received: 1, total: 4 }) })
  await uploadWith(w, 'slow.bin')
  await flushPromises()
  expect(w.text()).toContain('25%')
  expect(w.find('[data-test="relayHint"]').exists()).toBe(false)
})

test('下载到 100%(响应未回)不封顶,也不出写入提示', async () => {
  const w = mountBody()
  await flushPromises()
  calls.downloadImpl = (opts) => new Promise(() => { opts.onProgress?.({ received: 10, total: 10 }) })
  await w.findAll('[data-test="btnDownload"]')[0].trigger('click')
  await flushPromises()
  expect(w.text()).toContain('100%')
  expect(w.find('[data-test="relayHint"]').exists()).toBe(false)
})

test('上传完成 → 100% + ✓ 完成态,约 4s 后进度条自动收起', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const w = mountBody()
    await flushPromises()
    await uploadWith(w, 'ok.bin')
    await flushPromises()
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(true)
    expect(w.text()).toContain('100%')
    expect(w.find('[data-test="relayHint"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(4100)
    await flushPromises()
    expect(w.find('[data-test="progress"]').exists()).toBe(false)
  } finally { vi.useRealTimers() }
})

test('上传失败 → 进度条收起 + 行内错误(错误语义不变)', async () => {
  const w = mountBody()
  await flushPromises()
  calls.uploadImpl = (opts) => { opts.onProgress?.({ received: 2, total: 4 }); return Promise.reject(new Error('disk full')) }
  await uploadWith(w, 'bad.bin')
  await flushPromises()
  expect(w.find('[data-test="progress"]').exists()).toBe(false)
  expect(w.find('[data-test="error"]').text()).toContain('disk full')
})

test('done 后 4s 窗口内发起新传输:旧收起定时器不得误清新传输的进度条', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const w = mountBody()
    await flushPromises()
    await uploadWith(w, 'first.bin')            // 第一笔:立即完成 → done + 4s 收起定时器
    await flushPromises()
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(true)
    calls.uploadImpl = () => new Promise(() => {})   // 第二笔:窗口内发起,恒挂在途
    await uploadWith(w, 'second.bin')
    await flushPromises()
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(4100)     // 旧定时器到点
    await flushPromises()
    expect(w.find('[data-test="progress"]').exists()).toBe(true)
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(false)
  } finally { vi.useRealTimers() }
})

test('下载同款:done 后 4s 窗口内发起新下载,旧定时器到点不误清、不影响其完成交付', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
  try {
    const w = mountBody()
    await flushPromises()
    await w.findAll('[data-test="btnDownload"]')[0].trigger('click')   // A:立即完成 → done + 4s 定时器
    await flushPromises()
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(true)
    calls.downloadImpl = () => new Promise(resolve => { window.__emitB = () => resolve(new Blob(['b'])) })   // B:挂在途
    await w.findAll('[data-test="btnDownload"]')[0].trigger('click')
    await flushPromises()
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(4100)     // 旧定时器到点:B 的进度条必须还在
    await flushPromises()
    expect(w.find('[data-test="progress"]').exists()).toBe(true)
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(false)
    window.__emitB()                            // B 的字节随后到达 → 正常完成交付,无内部错误
    await flushPromises()
    expect(w.find('[data-test="doneFlag"]').exists()).toBe(true)
    expect(clickSpy).toHaveBeenCalledTimes(2)   // A、B 两笔各自完成交付
    expect(w.find('[data-test="error"]').exists()).toBe(false)
  } finally {
    delete window.__emitB
    clickSpy.mockRestore(); urlSpy.mockRestore(); vi.useRealTimers()
  }
})
