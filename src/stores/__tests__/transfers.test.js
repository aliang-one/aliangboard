// transfers store:任务状态机(active→done/error/canceled)/进度速度/取消/汇总;client 全 mock。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { fmtBytes, speedFromSamples } from '../transfers'

vi.mock('@/api/client', () => ({
  podFileApi: {
    downloadStream: vi.fn(),
    uploadStream: vi.fn(),
  },
}))
import { podFileApi } from '@/api/client'
import { useTransferStore } from '../transfers'

function deferred() { let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j }); return { p, resolve, reject } }

describe('fmtBytes/speedFromSamples', () => {
  it('fmtBytes', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(15 * 1024 * 1024)).toBe('15 MB')
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
  it('speedFromSamples:3s 窗口内 Δbytes/Δt', () => {
    const s = [{ t: 1000, received: 0 }, { t: 2000, received: 1024 }, { t: 4000, received: 1024 + 3 * 1024 }]
    expect(speedFromSamples(s, 4000)).toBeCloseTo(2048, 5)   // (4096-0)/2s
  })
})

describe('useTransferStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('startDownload:active 任务 + 进度更新 + 完成 done + 落盘', async () => {
    const d = deferred()
    podFileApi.downloadStream.mockImplementation((_p, { onProgress }) => {
      onProgress({ received: 5, total: 10 }); onProgress({ received: 10, total: 10 })
      return d.p
    })
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    const s = useTransferStore()
    s.startDownload({ namespace: 'ns', pod: 'p', container: 'c' }, '/etc/app.conf')
    const t = s.tasks[0]
    expect(t).toMatchObject({ kind: 'download', name: 'app.conf', status: 'active', received: 10, total: 10, namespace: 'ns' })
    d.resolve(new Blob(['x']))
    await vi.waitFor(() => expect(s.tasks[0].status).toBe('done'))
    expect(save).toHaveBeenCalled()
    urlSpy.mockRestore(); save.mockRestore()
  })

  it('下载失败 → error + error message;aborted → canceled', async () => {
    const d1 = deferred(), d2 = deferred()
    let n = 0
    podFileApi.downloadStream.mockImplementation(() => (++n === 1 ? d1.p : d2.p))
    const s = useTransferStore()
    s.startDownload({ namespace: 'ns', pod: 'p', container: '' }, '/a')
    s.startDownload({ namespace: 'ns', pod: 'p', container: '' }, '/b')
    d1.reject(Object.assign(new Error('超限'), { status: 413 }))
    d2.reject(Object.assign(new Error('aborted'), { aborted: true }))
    await vi.waitFor(() => expect(s.tasks.every(t => t.status !== 'active')).toBe(true))
    expect(s.tasks[0]).toMatchObject({ status: 'error', error: '超限' })
    expect(s.tasks[1].status).toBe('canceled')
  })

  it('startUpload:进度/完成 dir 记录;cancel 走 abort', async () => {
    const d = deferred()
    podFileApi.uploadStream.mockImplementation((_meta, _f, { onProgress, signal }) => {
      onProgress({ received: 3, total: 3 })
      signal.addEventListener('abort', () => d.reject(Object.assign(new Error('aborted'), { aborted: true })))
      return d.p
    })
    const s = useTransferStore()
    s.startUpload({ namespace: 'ns', pod: 'p', container: 'c' }, { dir: '/data', path: '/data/f.bin', file: { name: 'f.bin', size: 3 } })
    expect(s.tasks[0]).toMatchObject({ kind: 'upload', status: 'active', received: 3, total: 3, dir: '/data' })
    s.cancel(s.tasks[0].id)
    await vi.waitFor(() => expect(s.tasks[0].status).toBe('canceled'))
  })

  it('aggregate:多任务字节加权,total=0 不入分母;clearFinished/remove', () => {
    const s = useTransferStore()
    s.tasks.push(
      { id: '1', kind: 'download', status: 'done', received: 100, total: 100 },
      { id: '2', kind: 'download', status: 'active', received: 50, total: 200 },
      { id: '3', kind: 'download', status: 'active', received: 7, total: 0 },
    )
    const a = s.aggregate
    expect(a).toMatchObject({ count: 3, doneCount: 1, activeCount: 2, received: 150, total: 300 })
    expect(a.pct).toBe(50)
    s.clearFinished()
    expect(s.tasks.length).toBe(2)
    s.remove('2')
    expect(s.tasks.length).toBe(1)
  })
})
