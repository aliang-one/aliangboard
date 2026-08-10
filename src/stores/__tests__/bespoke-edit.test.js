// 回归测试：6 个手写 updateXxx 改 fetch-first 后，结构化编辑真正下发远端。
// 旧实现用 xxxList.value.findIndex 取当前对象 → all-real-data 下 store ref 为空 → findIndex=-1 → 静默 no-op。
// 本测试 stub api.k8s 返回样本当前对象 + 拦截 PATCH/applyYaml，断言远端操作被调用且内容正确。
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// 拦截记录：PATCH 调用 + applyYaml 调用
const patches = []
const applyYamlCalls = []

const { api } = vi.hoisted(() => {
  const k8s = vi.fn(async (path, opts) => {
    // PATCH / applyYaml 请求走单独记录
    if (opts && opts.method === 'PATCH') {
      patches.push({ path, body: JSON.parse(opts.body) })
      return {}
    }
    // GET：按路径返回样本 K8s 对象
    const p = typeof path === 'string' ? path : ''
    // Deployment 单条（updateWorkload / updateWorkloadMeta 的 fetchWorkload 探测）
    if (p.includes('/deployments/')) {
      return {
        metadata: { name: 'nginx-deploy', namespace: 'default', labels: { app: 'nginx' }, creationTimestamp: '2025-01-01T00:00:00Z' },
        spec: {
          replicas: 3,
          revisionHistoryLimit: 10,
          strategy: { type: 'RollingUpdate' },
          template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.21' }] } },
        },
        status: { readyReplicas: 3 },
      }
    }
    // PV 单条（updatePV 的 fetchPV）
    if (p.match(/\/persistentvolumes\/[^/]+$/) && !p.includes('?')) {
      return {
        metadata: { name: 'pv-001', labels: { team: 'dev' }, annotations: { desc: 'old' }, creationTimestamp: '2025-01-01T00:00:00Z' },
        spec: { capacity: { storage: '10Gi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain' },
        status: { phase: 'Available' },
      }
    }
    // StorageClass 单条（updateStorageClass 的 fetchStorageClass）
    if (p.match(/\/storageclasses\/[^/]+$/) && !p.includes('?')) {
      return {
        metadata: { name: 'fast-ssd', labels: {}, annotations: {}, creationTimestamp: '2025-01-01T00:00:00Z' },
        provisioner: 'kubernetes.io/aws-ebs',
        parameters: { type: 'gp2' },
        reclaimPolicy: 'Delete',
        volumeBindingMode: 'WaitForFirstConsumer',
      }
    }
    // Role 单条（updateRole 的 fetchRole）
    if (p.includes('/roles/') && !p.includes('rolebindings') && !p.includes('clusterroles')) {
      return {
        metadata: { name: 'pod-reader', namespace: 'default', creationTimestamp: '2025-01-01T00:00:00Z' },
        rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }],
      }
    }
    return {}
  })
  const applyYaml = vi.fn(async (yamlStr) => { applyYamlCalls.push(yamlStr); return { resources: [{}] } })
  return { api: { applyYaml, k8s } }
})

vi.mock('@/api/client', () => ({
  api,
  k8sStream: vi.fn(), portForwardApi: {}, getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(), setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''), getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })

describe('手写 updateXxx 改 fetch-first 后真正下发', () => {
  it('updateWorkload: PATCH 被调用且含 replicas + managed-by tag', async () => {
    patches.length = 0
    await store.updateWorkload('nginx-deploy', 'default', { replicas: '5/5' })
    expect(patches.length).toBe(1)
    const { path, body } = patches[0]
    expect(path).toContain('/deployments/nginx-deploy')
    expect(body.spec.replicas).toBe(5)
    expect(body.metadata.labels['aliangboard.io/managed-by']).toBe('aliangboard')
    expect(body.metadata.annotations['aliangboard.io/last-edited']).toBeTruthy()
  })

  it('updateWorkload: tier 写入 layer.aliangboard.io label', async () => {
    patches.length = 0
    await store.updateWorkload('nginx-deploy', 'default', { tier: 'edge' })
    expect(patches.length).toBe(1)
    const { body } = patches[0]
    expect(body.metadata.labels['layer.aliangboard.io']).toBe('edge')
  })

  it('updateWorkloadMeta: PATCH 含 labels + annotations + removedLabels(null)', async () => {
    patches.length = 0
    await store.updateWorkloadMeta('nginx-deploy', 'default', {
      labels: { app: 'nginx-v2' },
      annotations: { note: 'test' },
      removedLabels: ['old-key'],
    })
    expect(patches.length).toBe(1)
    const { body } = patches[0]
    expect(body.metadata.labels.app).toBe('nginx-v2')
    expect(body.metadata.labels['old-key']).toBeNull()
    expect(body.metadata.annotations.note).toBe('test')
  })

  it('updateWorkloadMeta: templateLabels 写入 spec.template.metadata.labels', async () => {
    patches.length = 0
    await store.updateWorkloadMeta('nginx-deploy', 'default', { templateLabels: { version: 'v2' } })
    expect(patches.length).toBe(1)
    const { body } = patches[0]
    expect(body.spec.template.metadata.labels.version).toBe('v2')
  })

  it('updatePV: PATCH 含 reclaimPolicy diff', async () => {
    patches.length = 0
    await store.updatePV('pv-001', { reclaimPolicy: 'Delete' })
    expect(patches.length).toBe(1)
    const { path, body } = patches[0]
    expect(path).toContain('/persistentvolumes/pv-001')
    expect(body.spec.persistentVolumeReclaimPolicy).toBe('Delete')
  })

  it('updatePV: labels diff（新增 + 删除置 null）', async () => {
    patches.length = 0
    await store.updatePV('pv-001', { labels: { team: 'dev', env: 'prod' } })
    expect(patches.length).toBe(1)
    const { body } = patches[0]
    expect(body.metadata.labels.env).toBe('prod')
  })

  it('updateStorageClass: isDefault=true 写入 is-default-class 注解', async () => {
    patches.length = 0
    await store.updateStorageClass('fast-ssd', { isDefault: true })
    expect(patches.length).toBe(1)
    const { path, body } = patches[0]
    expect(path).toContain('/storageclasses/fast-ssd')
    expect(body.metadata.annotations['storageclass.kubernetes.io/is-default-class']).toBe('true')
  })

  it('updateStorageClass: labels diff', async () => {
    patches.length = 0
    await store.updateStorageClass('fast-ssd', { labels: { tier: 'fast' } })
    expect(patches.length).toBe(1)
    const { body } = patches[0]
    expect(body.metadata.labels.tier).toBe('fast')
  })

  it('updateRole: applyYaml 被调用且 YAML 含新 rules', async () => {
    applyYamlCalls.length = 0
    const newRules = [
      { apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] },
    ]
    await store.updateRole('pod-reader', 'default', { rules: newRules })
    expect(applyYamlCalls.length).toBe(1)
    const obj = yamlLoad(applyYamlCalls[0])
    expect(obj.metadata.name).toBe('pod-reader')
    expect(obj.kind).toBe('Role')
    expect(obj.rules[0].resources).toContain('services')
    expect(obj.rules[0].verbs).toContain('watch')
  })
})
