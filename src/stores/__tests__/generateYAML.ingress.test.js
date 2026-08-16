import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// 回归:拓扑图「Service → + → Ingress」(NsWorkloadDetail.saveIngressMap)曾把 rules 拍成
// 扁平结构 { host, path, pathType, serviceName, servicePort }(缺 http.paths 包装)。
// generateYAML 只遍历 r.http?.paths → 扁平规则产出空 paths → networking.k8s.io/v1
// 校验失败(http.paths minItems=1)→ ingress 创建必败「根本没起作用」。
// 本测试锁死「创建者须传嵌套 rules(http.paths[].backend)」契约,并显式记录扁平输入的
// 不可用边界,避免 NsWorkloadDetail 之外的其他创建入口再次踩同样的坑。

vi.mock('@/api/client', () => ({
  api: { applyYaml: vi.fn(), k8s: vi.fn() },
  k8sStream: vi.fn(),
  portForwardApi: {},
  getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(),
  removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''),
  getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => {
  setActivePinia(createPinia())
  store = useClusterStore()
})

describe('generateYAML: ingress rules 形状契约', () => {
  it('嵌套 rules(http.paths[].backend) → 产出合法 path(含 service 名 + 端口号)', () => {
    // NsIngress.vue / 修复后 NsWorkloadDetail.saveIngressMap 发送的形状
    const yaml = store.generateYAML('ingress', {
      name: 'app-ingress', namespace: 'default',
      rules: [{
        host: 'app.example.com',
        http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'app-svc', servicePort: 80 } }] },
      }],
    })
    const obj = yamlLoad(yaml)
    const paths = obj.spec.rules[0].http.paths
    expect(paths).toHaveLength(1)
    expect(paths[0].backend.service.name).toBe('app-svc')
    expect(paths[0].backend.service.port.number).toBe(80)
    expect(paths[0].path).toBe('/')
    expect(paths[0].pathType).toBe('Prefix')
  })

  it('扁平 rules(无 http.paths,拓扑旧 payload)→ 空 paths,K8s 必校验失败', () => {
    // NsWorkloadDetail.saveIngressMap 修复前发送的形状:锁死其不可用边界
    const yaml = store.generateYAML('ingress', {
      name: 'app-ingress', namespace: 'default',
      rules: [{ host: 'app.example.com', path: '/', pathType: 'Prefix', serviceName: 'app-svc', servicePort: 80 }],
    })
    const obj = yamlLoad(yaml)
    // generateYAML 遍历 r.http?.paths;扁平规则无 http → 不产出任何 path → null/[]
    expect(obj.spec.rules[0].http.paths || []).toHaveLength(0)
  })
})

describe('generateYAML: ingress tlsList(③ per-host TLS 优先路径)', () => {
  const rules = [
    { host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'svc-a', port: { number: 80 } } } }] } },
    { host: 'b.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'svc-b', port: { number: 8080 } } } }] } },
  ]

  it('tlsList 非空 → 按序产出多条 per-host tls 块(hostsToK8sSpec 形状)', () => {
    const yaml = store.generateYAML('ingress', {
      name: 'multi', namespace: 'default', rules,
      tlsList: [{ hosts: ['a.example.com'], secretName: 'a-tls' }, { hosts: ['b.example.com'], secretName: 'b-tls' }],
    })
    const obj = yamlLoad(yaml)
    expect(obj.spec.tls).toEqual([
      { hosts: ['a.example.com'], secretName: 'a-tls' },
      { hosts: ['b.example.com'], secretName: 'b-tls' },
    ])
  })

  it('tlsList 非空时优先于存量单 tls 布尔(忽略 tls/tlsSecret)', () => {
    const yaml = store.generateYAML('ingress', {
      name: 'x', namespace: 'default', rules,
      tls: true, tlsSecret: 'legacy-tls',
      tlsList: [{ hosts: ['a.example.com'], secretName: 'list-tls' }],
    })
    expect(yamlLoad(yaml).spec.tls).toEqual([{ hosts: ['a.example.com'], secretName: 'list-tls' }])
  })

  it('不传 tlsList(② 暴露弹窗等存量调用方)→ 单 tls 兜底行为不变', () => {
    const yaml = store.generateYAML('ingress', {
      name: 'x', namespace: 'default', rules,
      tls: true, tlsSecret: 'legacy-tls',
    })
    expect(yamlLoad(yaml).spec.tls).toEqual([{ hosts: ['a.example.com'], secretName: 'legacy-tls' }])
  })

  it('tlsList 空数组(③ 全关 TLS)且 tls 为假 → 不产出 tls 块', () => {
    const yaml = store.generateYAML('ingress', {
      name: 'x', namespace: 'default', rules, tls: false, tlsList: [],
    })
    expect(yamlLoad(yaml).spec.tls).toBeUndefined()
  })
})
