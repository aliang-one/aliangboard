// issue#16:workload CRUD 链 batch 家族支持。旧态三宗罪:
// ① updateWorkload plural 白名单只认 apps 三类 → CronJob 编辑弹窗「假保存」(无请求无报错);
// ② deleteWorkload 同白名单 → Job/CronJob 删除必报 deleteNotSupported;
// ③ getWorkloadForEdit 探测只走 apps 三类 → 缓存未命中时 batch 恒 null。
// 回归钉:strategy/revisionHistoryLimit 仅 Deployment 可入 patch(旧实现无条件塞,STS/DS 被
// 静默携带 Deployment 专属字段);Job 的 spec.template 不可变(K8s 拒改)→ labels-only。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { queryClient } from '@/queryClient'

const mut = []
const { api } = vi.hoisted(() => ({
  api: {
    k8s: vi.fn(async (path, opts) => {
      const method = opts?.method || 'GET'
      if (method !== 'GET') { mut.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null }); return {} }
      if (typeof path === 'string' && path.includes('/cronjobs/')) {
        return {
          metadata: { name: 'backup', namespace: 'default' },
          spec: { schedule: '*/5 * * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'busybox:1.36' }] } } } } },
          status: {},
        }
      }
      if (typeof path === 'string' && path.includes('/jobs/')) {
        return {
          metadata: { name: 'migrate', namespace: 'default' },
          spec: { template: { spec: { containers: [{ name: 'migrate', image: 'migrate:v5' }] } } },
          status: {},
        }
      }
      // 其余单资源 GET(探测未命中的类型)→ 404,与真实 apiserver 语义一致
      throw new Error('404 Not Found')
    }),
  },
}))
vi.mock('@/api/client', () => ({
  api, k8sStream: vi.fn(), portForwardApi: {}, getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(), setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''), getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })
beforeEach(() => { mut.length = 0; queryClient.clear() })

const WL_KEY = ['cluster', 'cluster', 'workloads']
const cron = () => ({
  name: 'backup', namespace: 'default', type: 'CronJob', replicas: '0/0', image: 'busybox:1.36', schedule: '*/5 * * * *', suspend: false,
  raw: { spec: { schedule: '*/5 * * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'busybox:1.36' }] } } } } }, status: {} },
})
const job = () => ({
  name: 'migrate', namespace: 'default', type: 'Job', replicas: '0/1', image: 'migrate:v5',
  raw: { spec: { template: { spec: { containers: [{ name: 'migrate', image: 'migrate:v5' }] } } }, status: {} },
})
const deploy = () => ({
  name: 'nginx', namespace: 'default', type: 'Deployment', replicas: '3/3', image: 'nginx:1.21',
  raw: { spec: { replicas: 3, template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.21' }] } } }, status: { readyReplicas: 3 } },
})
const sts = () => ({
  name: 'mysql', namespace: 'default', type: 'StatefulSet', replicas: '1/1', image: 'mysql:8',
  raw: { spec: { replicas: 1, template: { spec: { containers: [{ name: 'mysql', image: 'mysql:8' }] } } }, status: { readyReplicas: 1 } },
})

describe('deleteWorkload · batch', () => {
  it('CronJob → DELETE batch/v1 路径,返回 true(旧实现必报 deleteNotSupported)', async () => {
    queryClient.setQueryData(WL_KEY, [cron()])
    const ok = await store.deleteWorkload('backup', 'default')
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('DELETE')
    expect(mut[0].path).toBe('/apis/batch/v1/namespaces/default/cronjobs/backup')
    expect(ok).toBe(true)
  })

  it('缓存未命中(Job) → 探测含 batch 类型后 DELETE(旧探测只走 apps 三类恒 null)', async () => {
    const ok = await store.deleteWorkload('migrate', 'default')
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('DELETE')
    expect(mut[0].path).toBe('/apis/batch/v1/namespaces/default/jobs/migrate')
    expect(ok).toBe(true)
  })

  it('DELETE 失败 → notify + 返回 false(不再无条件跳列表页的依据)', async () => {
    queryClient.setQueryData(WL_KEY, [cron()])
    const { api: realApi } = await import('@/api/client')
    realApi.k8s.mockRejectedValueOnce(new Error('403'))
    const ok = await store.deleteWorkload('backup', 'default')
    expect(ok).toBe(false)
    const { notify } = await import('@/composables/useToast')
    expect(notify).toHaveBeenCalled()
  })
})

describe('updateWorkload · CronJob 真保存(旧实现静默 no-op = 假保存)', () => {
  it('schedule/suspend/image/labels 全量 PATCH 到 batch/v1,镜像走 jobTemplate 面', async () => {
    queryClient.setQueryData(WL_KEY, [cron()])
    await store.updateWorkload('backup', 'default', {
      schedule: '0 * * * *', suspend: true, image: 'busybox:1.37', labels: { app: 'backup' }, tier: 'job',
    })
    expect(mut.length).toBe(1)
    const [m] = mut
    expect(m.method).toBe('PATCH')
    expect(m.path).toBe('/apis/batch/v1/namespaces/default/cronjobs/backup')
    expect(m.body.spec.schedule).toBe('0 * * * *')
    expect(m.body.spec.suspend).toBe(true)
    expect(m.body.spec.jobTemplate.spec.template.spec.containers[0].image).toBe('busybox:1.37')
    expect(m.body.metadata.labels.app).toBe('backup')
    // Deployment 专属字段不得入 CronJob patch
    expect(m.body.spec.strategy).toBeUndefined()
    expect(m.body.spec.replicas).toBeUndefined()
    expect(m.body.spec.template).toBeUndefined()
  })

  it('仅改 labels → patch 无 spec 键', async () => {
    queryClient.setQueryData(WL_KEY, [cron()])
    await store.updateWorkload('backup', 'default', { labels: { app: 'backup' } })
    expect(mut.length).toBe(1)
    expect(mut[0].body.spec).toBeUndefined()
  })

  it('schedule 置空串不发 spec.schedule(防误清空)', async () => {
    queryClient.setQueryData(WL_KEY, [cron()])
    await store.updateWorkload('backup', 'default', { schedule: '' })
    expect(mut.length).toBe(1)
    expect(mut[0].body.spec?.schedule).toBeUndefined()
  })
})

describe('updateWorkload · Job spec 不可变语义', () => {
  it('labels 可改;image/replicas 不入 patch(K8s 拒改 Job spec.template)', async () => {
    queryClient.setQueryData(WL_KEY, [job()])
    await store.updateWorkload('migrate', 'default', { labels: { app: 'm' }, image: 'migrate:v6', replicas: '2/2', strategy: 'RollingUpdate' })
    expect(mut.length).toBe(1)
    expect(mut[0].path).toBe('/apis/batch/v1/namespaces/default/jobs/migrate')
    expect(mut[0].body.metadata.labels.app).toBe('m')
    expect(mut[0].body.spec).toBeUndefined()
  })
})

describe('updateWorkload · apps 三类零回归 + strategy 收敛为 Deployment 专属', () => {
  it('Deployment: strategy/revisionHistoryLimit 照旧入 patch', async () => {
    queryClient.setQueryData(WL_KEY, [deploy()])
    await store.updateWorkload('nginx', 'default', { strategy: 'RollingUpdate', maxSurge: '25%', maxUnavailable: 1, revisionHistoryLimit: 5 })
    expect(mut.length).toBe(1)
    expect(mut[0].body.spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 1 } })
    expect(mut[0].body.spec.revisionHistoryLimit).toBe(5)
  })

  it('StatefulSet: strategy/revisionHistoryLimit 不再被静默携带(旧实现无条件塞 Deployment 专属字段)', async () => {
    queryClient.setQueryData(WL_KEY, [sts()])
    await store.updateWorkload('mysql', 'default', { strategy: 'RollingUpdate', maxSurge: '25%', revisionHistoryLimit: 10 })
    expect(mut.length).toBe(1)
    expect(mut[0].body.spec).toBeUndefined()
  })
})

describe('同 ns 同名跨 kind type 判别(对抗审查 P1:K8s 合法形态,删错对象=最重后果)', () => {
  // 同 ns 下 Deployment 'x' 与 CronJob 'x' 并存(列表 Deployment 在前)
  const bothKinds = () => [deploy(), { ...cron(), name: 'nginx', raw: { ...cron().raw, metadata: { name: 'nginx', namespace: 'default' } } }]

  it('deleteWorkload 带 typeHint 删对对象(CronJob 提示 → DELETE cronjobs/nginx)', async () => {
    queryClient.setQueryData(WL_KEY, bothKinds())
    const ok = await store.deleteWorkload('nginx', 'default', 'CronJob')
    expect(ok).toBe(true)
    expect(mut[0].path).toBe('/apis/batch/v1/namespaces/default/cronjobs/nginx')
  })

  it('deleteWorkload 带 typeHint=Deployment 删 Deployment(同缓存不串)', async () => {
    queryClient.setQueryData(WL_KEY, bothKinds())
    await store.deleteWorkload('nginx', 'default', 'Deployment')
    expect(mut[0].path).toBe('/apis/apps/v1/namespaces/default/deployments/nginx')
  })

  it('不带 typeHint 保持旧行为(命中缓存首个,兼容存量调用点)', async () => {
    queryClient.setQueryData(WL_KEY, bothKinds())
    await store.deleteWorkload('nginx', 'default')
    expect(mut[0].path).toBe('/apis/apps/v1/namespaces/default/deployments/nginx')
  })

  it('updateWorkload 带 typeHint:patch 落 CronJob 面(schedule 生效)', async () => {
    queryClient.setQueryData(WL_KEY, bothKinds())
    await store.updateWorkload('nginx', 'default', { schedule: '0 0 * * *' }, 'CronJob')
    expect(mut[0].path).toBe('/apis/batch/v1/namespaces/default/cronjobs/nginx')
    expect(mut[0].body.spec.schedule).toBe('0 0 * * *')
  })

  it('缓存未命中 + typeHint:只探测该类型(不再盲扫 5 类)', async () => {
    await store.deleteWorkload('backup', 'default', 'CronJob')
    expect(mut.length).toBe(1)
    expect(mut[0].path).toBe('/apis/batch/v1/namespaces/default/cronjobs/backup')
  })
})
