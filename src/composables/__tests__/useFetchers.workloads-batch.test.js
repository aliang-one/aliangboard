// issue#16:fetchWorkloads 必须拉满 5 类工作负载(apps 三类 + batch 双类)。
// 死 UI 根因:列表数据源只拉 deployments/statefulsets/daemonsets,NsWorkloads/Workloads 的
// Job/CronJob 筛选、统计卡、导出全是等不到数据的死 UI。batch 端点失败(RBAC 收窄)时
// apps 三类必须照常返回(优雅降级,与 CopyWorkloadDialog 逐类 catch 同语义)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKLOAD_TYPES, WORKLOAD_API } from '@/logic/workloadMeta'

const { api } = vi.hoisted(() => ({ api: { k8s: vi.fn() } }))
vi.mock('@/api/client', () => ({ api }))
vi.mock('@/composables/watchRegistry', () => ({ recordListRv: vi.fn(), getListRv: vi.fn(), clearWatchRegistry: vi.fn() }))

import { fetchWorkloads } from '../useFetchers'

const LIST = {
  '/apis/apps/v1/deployments': [{ metadata: { name: 'd1', namespace: 'default' }, spec: {}, status: {} }],
  '/apis/apps/v1/statefulsets': [{ metadata: { name: 's1', namespace: 'default' }, spec: {}, status: {} }],
  '/apis/apps/v1/daemonsets': [{ metadata: { name: 'ds1', namespace: 'default' }, spec: {}, status: {} }],
  '/apis/batch/v1/jobs': [{ metadata: { name: 'j1', namespace: 'default' }, spec: {}, status: {} }],
  '/apis/batch/v1/cronjobs': [{ metadata: { name: 'cj1', namespace: 'default' }, spec: {}, status: {} }],
}

beforeEach(() => {
  api.k8s.mockImplementation(async path => {
    const base = String(path).split('?')[0]
    if (base in LIST) return { metadata: { resourceVersion: '1' }, items: LIST[base] }
    throw new Error(`unexpected path ${path}`)
  })
})

describe('fetchWorkloads · batch 家族入列(issue#16)', () => {
  it('拉 5 端点,产出含全部 5 类 type', async () => {
    const list = await fetchWorkloads()
    const types = [...new Set(list.map(w => w.type))].sort()
    expect(types).toEqual(['CronJob', 'DaemonSet', 'Deployment', 'Job', 'StatefulSet'])
    const paths = api.k8s.mock.calls.map(c => String(c[0]).split('?')[0])
    expect(paths).toContain('/apis/batch/v1/jobs')
    expect(paths).toContain('/apis/batch/v1/cronjobs')
  })

  it('batch 端点 403(RBAC 收窄)时 apps 三类照常返回——不因 batch 缺权限全局失败', async () => {
    api.k8s.mockImplementation(async path => {
      const base = String(path).split('?')[0]
      if (base.startsWith('/apis/batch/')) { const e = new Error('403'); e.status = 403; throw e }
      return { metadata: { resourceVersion: '1' }, items: LIST[base] }
    })
    const list = await fetchWorkloads()
    expect(list.map(w => w.type).sort()).toEqual(['DaemonSet', 'Deployment', 'StatefulSet'])
  })

  it('端点列表沿用 WORKLOAD_API 单源派生(对抗审查 P3:注释声称单源则须真单源)', async () => {
    await fetchWorkloads()
    const called = api.k8s.mock.calls.map(c => String(c[0]).split('?')[0])
    for (const [, [gv, plural]] of Object.entries(WORKLOAD_API)) {
      expect(called).toContain(`/apis/${gv}/${plural}`)
    }
  })

  it('非 403 瞬态失败(如 503)不得静默蒸发整类(对抗审查 P2):任一端点 5xx → 整体 reject 保旧数据+重试', async () => {
    api.k8s.mockImplementation(async path => {
      const base = String(path).split('?')[0]
      if (base === '/apis/apps/v1/deployments') { const e = new Error('503'); e.status = 503; throw e }
      return { metadata: { resourceVersion: '1' }, items: LIST[base] }
    })
    await expect(fetchWorkloads()).rejects.toThrow()
  })

  it('五端点全失败 → reject(不得空成功覆盖缓存)', async () => {
    api.k8s.mockImplementation(async () => { const e = new Error('502'); e.status = 502; throw e })
    await expect(fetchWorkloads()).rejects.toThrow()
  })

  it('403 判定按 error.status:仅 status=403 静默降级,message 文本 403 而无 status 不算', async () => {
    api.k8s.mockImplementation(async path => {
      const base = String(path).split('?')[0]
      if (base.startsWith('/apis/batch/')) { const e = new Error('Forbidden'); e.status = 403; throw e }
      return { metadata: { resourceVersion: '1' }, items: LIST[base] }
    })
    const list = await fetchWorkloads()
    expect(list.map(w => w.type)).not.toContain('CronJob')
  })
})

describe('死 UI 守卫:筛选词表必须与数据源 kind 集对齐', () => {
  it('fetchWorkloads 产出 kind 全集 === WORKLOAD_TYPES 单源', async () => {
    const list = await fetchWorkloads()
    expect([...new Set(list.map(w => w.type))].sort()).toEqual([...WORKLOAD_TYPES].sort())
  })

  it('两个列表页的类型筛选词表走 WORKLOAD_TYPES 单源(禁止手写 kind 数组)', () => {
    const views = [
      resolve(process.cwd(), 'src/views/NsWorkloads.vue'),
      resolve(process.cwd(), 'src/views/Workloads.vue'),
    ]
    for (const f of views) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} 须 import WORKLOAD_TYPES`).toMatch(/import\s*\{[^}]*WORKLOAD_TYPES[^}]*\}\s*from\s*'@\/logic\/workloadMeta'/)
      // 手写 typeOptions/类型 options 字面量 = 词表与数据源脱钩的死 UI 温床
      expect(src, `${f} 禁止手写类型词表`).not.toMatch(/typeOptions\s*=\s*\[\s*'All',\s*'Deployment'/)
      expect(src, `${f} 禁止手写类型词表`).not.toMatch(/options:\s*\[\s*'All Types',\s*'Deployment'/)
    }
  })
})
