// issue#16:mapWorkload batch 家族感知。回归背景:2026-07-26 对接真实集群起 workload 列表
// 数据源只含 deploy/sts/ds,Job/CronJob 从未进列表(编辑回填恒空/状态恒错)。
// 本文件钉住 batch 双 kind 的映射契约:Job(状态/完成度)、CronJob(schedule/suspend/jobTemplate 镜像)。
import { describe, it, expect } from 'vitest'
import { mapWorkload } from '../useResourceMappers'

const meta = (name, ns = 'default') => ({ name, namespace: ns, creationTimestamp: '2026-09-01T00:00:00Z', labels: {}, annotations: {} })

describe('mapWorkload · CronJob', () => {
  const cronRaw = (spec = {}, status = {}) => ({
    metadata: meta('backup'),
    spec: {
      schedule: '*/5 * * * *',
      jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'busybox:1.36' }] } } } },
      ...spec,
    },
    status,
  })

  it('提取 schedule 与 jobTemplate 内镜像(旧实现两处恒空——编辑回填断裂的根)', () => {
    const w = mapWorkload(cronRaw(), 'CronJob')
    expect(w.schedule).toBe('*/5 * * * *')
    expect(w.image).toBe('busybox:1.36')
  })

  it('active>0 → Running;suspend=true → Pending;空闲且曾成功 → Succeeded;从未跑过 → Pending', () => {
    const active = mapWorkload(cronRaw({}, { active: ['uid-1'], lastSuccessfulTime: '2026-09-01T01:00:00Z' }), 'CronJob')
    expect(active.status).toBe('Running')
    expect(active.replicas).toBe('1/1')
    const suspended = mapWorkload(cronRaw({ suspend: true }, {}), 'CronJob')
    expect(suspended.status).toBe('Pending')
    expect(suspended.suspend).toBe(true)
    const idleOk = mapWorkload(cronRaw({}, { lastSuccessfulTime: '2026-09-01T01:00:00Z' }), 'CronJob')
    expect(idleOk.status).toBe('Succeeded')
    expect(idleOk.replicas).toBe('0/0')
    const never = mapWorkload(cronRaw({}, {}), 'CronJob')
    expect(never.status).toBe('Pending')
  })
})

describe('mapWorkload · Job', () => {
  const jobRaw = (spec = {}, status = {}) => ({
    metadata: meta('migrate'),
    spec: { template: { spec: { containers: [{ name: 'migrate', image: 'migrate:v5' }] } }, ...spec },
    status,
  })

  it('完成态:Complete=True → Succeeded,replicas=succeeded/completions(旧实现恒 Pending+0/1)', () => {
    const w = mapWorkload(jobRaw({ completions: 3 }, { succeeded: 3, conditions: [{ type: 'Complete', status: 'True' }] }), 'Job')
    expect(w.status).toBe('Succeeded')
    expect(w.replicas).toBe('3/3')
    expect(w.image).toBe('migrate:v5')
  })

  it('运行中(active>0) → Running;失败(Failed=True) → Failed;未跑 → Pending', () => {
    expect(mapWorkload(jobRaw({}, { active: 1 }), 'Job').status).toBe('Running')
    expect(mapWorkload(jobRaw({}, { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] }), 'Job').status).toBe('Failed')
    expect(mapWorkload(jobRaw({}, {}), 'Job').status).toBe('Pending')
  })

  it('completions 未设(parallel 语义)按 1 计', () => {
    const w = mapWorkload(jobRaw({}, { succeeded: 1 }), 'Job')
    expect(w.replicas).toBe('1/1')
  })
})

describe('mapWorkload · apps 三类零回归', () => {
  it('Deployment 映射形状不变(replicas/status/image 走原路径)', () => {
    const w = mapWorkload({
      metadata: meta('nginx'),
      spec: { replicas: 3, template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.21' }] } } },
      status: { readyReplicas: 3 },
    }, 'Deployment')
    expect(w).toMatchObject({ name: 'nginx', type: 'Deployment', status: 'Running', replicas: '3/3', image: 'nginx:1.21' })
    expect(w.schedule).toBeUndefined()
    expect(w.suspend).toBeUndefined()
  })

  it('带出 metadata.uid:同 ns 同名跨 kind(Deployment x + CronJob x,K8s 合法)身份键不撞(watch 合并/去重依赖 uidKey)', () => {
    const d = mapWorkload({ metadata: { ...meta('x'), uid: 'uid-d' }, spec: {}, status: {} }, 'Deployment')
    const c = mapWorkload({ metadata: { ...meta('x'), uid: 'uid-c' }, spec: {}, status: {} }, 'CronJob')
    expect(d.uid).toBe('uid-d')
    expect(c.uid).toBe('uid-c')
  })
})
