// fileBrowsers store:去重聚焦/最小化恢复/持久化调用(api 全 mock)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/client', () => ({
  fileBrowserApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
import { fileBrowserApi } from '@/api/client'
import { useFileBrowserStore } from '../fileBrowsers'

describe('useFileBrowserStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('openBrowser:新建 open 任务并持久化;同 pod+container 去重聚焦', () => {
    const s = useFileBrowserStore()
    s.openBrowser({ namespace: 'ns', podName: 'p1', container: 'c1' })
    expect(s.browsers).toHaveLength(1)
    expect(s.browsers[0]).toMatchObject({ namespace: 'ns', podName: 'p1', container: 'c1', status: 'open' })
    expect(fileBrowserApi.create).toHaveBeenCalledTimes(1)
    s.minimizeBrowser(s.browsers[0].id)
    const again = s.openBrowser({ namespace: 'ns', podName: 'p1', container: 'c1' })
    expect(s.browsers).toHaveLength(1)
    expect(again.status).toBe('open')
    expect(fileBrowserApi.create).toHaveBeenCalledTimes(1)          // 未重复建
    expect(fileBrowserApi.update).toHaveBeenCalledWith(s.browsers[0].id, { status: 'open' })
  })
  it('minimize/restore/close:状态流转 + 持久化', () => {
    const s = useFileBrowserStore()
    const b = s.openBrowser({ namespace: 'ns', podName: 'p', container: '' })
    s.minimizeBrowser(b.id)
    expect(s.browsers[0].status).toBe('minimized')
    s.restoreBrowser(b.id)
    expect(s.browsers[0].status).toBe('open')
    s.closeBrowser(b.id)
    expect(s.browsers).toHaveLength(0)
    expect(fileBrowserApi.remove).toHaveBeenCalledWith(b.id)
  })
  it('loadPersisted:恢复为 minimized', async () => {
    fileBrowserApi.list.mockResolvedValue({ browsers: [{ id: 'x', name: 'p/c', namespace: 'ns', podName: 'p', container: 'c', status: 'open', createdAt: 1 }] })
    const s = useFileBrowserStore()
    await s.loadPersisted()
    expect(s.browsers[0].status).toBe('minimized')
  })
})

describe('loadPersisted merge(2026-09-04 竞态修复)', () => {
  it('慢回包不抹掉本地窗口;服务端新记录补入;本页已关闭的不复活', async () => {
    let resolveList
    fileBrowserApi.list.mockReturnValueOnce(new Promise(r => { resolveList = r }))
    const s = useFileBrowserStore()
    const p = s.loadPersisted()
    const b = s.openBrowser({ namespace: 'ns', podName: 'p1', container: 'c1' })
    s.closeBrowser(b.id)                              // list 在途期间显式关闭
    resolveList({ browsers: [
      { id: b.id, name: 'p1/c1', namespace: 'ns', podName: 'p1', container: 'c1', status: 'open', createdAt: 1 },
      { id: 'x', name: 'p2/c', namespace: 'ns', podName: 'p2', container: 'c', status: 'open', createdAt: 2 },
    ] })
    await p
    expect(s.browsers.map(x => x.id)).toEqual(['x'])  // 已关的不复活,服务端新记录补入
    expect(s.browsers[0].status).toBe('minimized')
  })
})
