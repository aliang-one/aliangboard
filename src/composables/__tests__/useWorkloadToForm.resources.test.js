// 复制链资源保真(2026-10-11 工作流审计 #4/B2 根修配套):
// - 无 resources/部分 resources 的源复制后不再凭空注入 250m/500m/256Mi/512Mi 默认值
//   (违背 mapSubContainer 已固化不变式:复制=忠实克隆,曾致无上限容器复制后挂 512Mi 直接 OOMKill);
// - cpu/memory 之外的第三资源键(ephemeral-storage/nvidia.com/gpu)以 extraResources 携带,
//   向导 buildSubContainerSpec/mergeResources 侧合并回输出。
import { describe, it, expect } from 'vitest'
import { workloadToForm } from '@/composables/useWorkloadToForm'

function deployWith(container) {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'app', namespace: 'default' },
    spec: { replicas: 1, template: { metadata: { labels: { app: 'app' } }, spec: { containers: [container] } } },
  }
}

describe('workloadToForm: 主容器资源映射', () => {
  it('无 resources → 四键全空(不注入默认值)', () => {
    const out = workloadToForm(deployWith({ name: 'c', image: 'nginx' }), 'Deployment')
    expect(out.cpuRequest).toBe('')
    expect(out.cpuLimit).toBe('')
    expect(out.memoryRequest).toBe('')
    expect(out.memoryLimit).toBe('')
    expect(out.extraResources).toBe(null)
  })
  it('有 requests 无 limits → limits 键空(不补 500m/512Mi)', () => {
    const out = workloadToForm(deployWith({ name: 'c', image: 'nginx', resources: { requests: { cpu: '100m', memory: '128Mi' } } }), 'Deployment')
    expect(out.cpuRequest).toBe('100m')
    expect(out.memoryRequest).toBe('128Mi')
    expect(out.cpuLimit).toBe('')
    expect(out.memoryLimit).toBe('')
  })
  it('第三资源键 → extraResources 携带(复制链不再静默丢 GPU/ephemeral-storage)', () => {
    const out = workloadToForm(deployWith({
      name: 'c', image: 'nginx',
      resources: { requests: { cpu: '100m' }, limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi', 'nvidia.com/gpu': '1' } },
    }), 'Deployment')
    expect(out.extraResources).toEqual({ limits: { 'ephemeral-storage': '1Gi', 'nvidia.com/gpu': '1' } })
    expect(out.cpuLimit).toBe('1')
  })
  it('子容器第三资源键同样携带', () => {
    const raw = deployWith({ name: 'c', image: 'nginx' })
    raw.spec.template.spec.containers.push({ name: 'sc', image: 'envoy', resources: { limits: { 'nvidia.com/gpu': '1' } } })
    const out = workloadToForm(raw, 'Deployment')
    expect(out.extraContainers[0].extraResources).toEqual({ limits: { 'nvidia.com/gpu': '1' } })
    expect(out.extraContainers[0].cpuLimit).toBe('')
  })
})
