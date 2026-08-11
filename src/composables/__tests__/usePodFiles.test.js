import { test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({
  podFileApi: {
    list: vi.fn(), read: vi.fn(), write: vi.fn(), download: vi.fn(),
  },
}))
import { podFileApi } from '@/api/client'
import { usePodFiles } from '../usePodFiles'

const CTX = { namespace: 'ns', pod: 'p', container: 'c' }

beforeEach(() => {
  podFileApi.list.mockReset(); podFileApi.read.mockReset()
  podFileApi.write.mockReset(); podFileApi.download.mockReset()
})

test('listDir: 同 ctx+path 命中缓存只请求一次', async () => {
  podFileApi.list.mockResolvedValue({ entries: [{ name: 'a', type: 'file' }] })
  const { listDir } = usePodFiles()
  await listDir(CTX, '/x'); await listDir(CTX, '/x')
  expect(podFileApi.list).toHaveBeenCalledTimes(1)
})

test('listDir: force 绕过缓存', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  const { listDir } = usePodFiles()
  await listDir(CTX, '/x'); await listDir(CTX, '/x', { force: true })
  expect(podFileApi.list).toHaveBeenCalledTimes(2)
})

test('listDir: 目录在前排序', async () => {
  podFileApi.list.mockResolvedValue({ entries: [
    { name: 'z.txt', type: 'file' }, { name: 'a', type: 'dir' }, { name: 'm', type: 'dir' },
  ] })
  const { listDir } = usePodFiles()
  const e = await listDir(CTX, '/')
  expect(e.map(x => x.name)).toEqual(['a', 'm', 'z.txt'])
})

test('listDir: 不同 container 隔离缓存', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  const { listDir } = usePodFiles()
  await listDir(CTX, '/x'); await listDir({ ...CTX, container: 'other' }, '/x')
  expect(podFileApi.list).toHaveBeenCalledTimes(2)
})

test('readFile: 命中缓存', async () => {
  podFileApi.read.mockResolvedValue({ path: '/a.go', content: 'x', truncated: false, binary: false })
  const { readFile } = usePodFiles()
  await readFile(CTX, '/a.go'); await readFile(CTX, '/a.go')
  expect(podFileApi.read).toHaveBeenCalledTimes(1)
})

test('writeFile: invalidate 文件 + 父目录缓存', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  podFileApi.read.mockResolvedValue({ path: '/d/f.txt', content: 'x', truncated: false, binary: false })
  podFileApi.write.mockResolvedValue({ ok: true })
  const { listDir, readFile, writeFile } = usePodFiles()
  await listDir(CTX, '/d'); await readFile(CTX, '/d/f.txt')
  expect(podFileApi.list).toHaveBeenCalledTimes(1)
  expect(podFileApi.read).toHaveBeenCalledTimes(1)
  await writeFile(CTX, '/d/f.txt', new TextEncoder().encode('y'))
  await listDir(CTX, '/d'); await readFile(CTX, '/d/f.txt')
  expect(podFileApi.list).toHaveBeenCalledTimes(2) // 父目录被失效→重取
  expect(podFileApi.read).toHaveBeenCalledTimes(2)  // 文件被失效→重取
})

test('resetForContainer: 只清当前 container', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  const { listDir, resetForContainer } = usePodFiles()
  await listDir(CTX, '/x'); await listDir({ ...CTX, container: 'b' }, '/x')
  resetForContainer('c')
  await listDir(CTX, '/x')                       // c 已清→重取
  await listDir({ ...CTX, container: 'b' }, '/x') // b 仍在→命中
  expect(podFileApi.list).toHaveBeenCalledTimes(3)
})
