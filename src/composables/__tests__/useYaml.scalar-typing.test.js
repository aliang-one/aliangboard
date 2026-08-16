import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// 回归:Ingress 页改注解报 K8s 拒收——
//   .metadata.annotations.nginx.ingress.kubernetes.io/proxy-send-timeout:
//   expected string, got valueUnstructured{Value:3600}
// 根因:yamlScalar 只防「换行/空贴边/特殊字符」,漏防 YAML 隐式类型化——
// 裸 3600 / true / ~ / 2026-08-16 会被 apiserver(sigs.k8s.io/yaml→yaml.v2,YAML 1.1
// 语义)解析成 int/bool/null/timestamp,而 annotations/labels/ConfigMap data 都是
// map[string]string,必被拒(bool/int 报错)或遭静默改写(timestamp→RFC3339)。
// 修复:凡「YAML 1.1 会解析成非字符串」的值一律双引号包裹。
//
// 注意:不能用 js-yaml round-trip 当唯一裁判——它是 1.2 core 语义,yes/on/y 等返回
// 字符串,而 K8s 的 yaml.v2(1.1)解析成 bool。故真相表直接断言 yamlScalar 的产出形态。

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

import { yamlScalar } from '@/composables/useYaml'
import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => {
  setActivePinia(createPinia())
  store = useClusterStore()
})

// YAML 1.1(yaml.v2)隐式类型化真相表:这些值裸输出必被 K8s 误解析,必须双引号。
const DANGEROUS = [
  // int(十进制/符号/前导零八进制/下划线分隔)
  '3600', '60', '0', '-5', '+7', '0755', '1_000', '31536000',
  // int(0x/0b/0o 进制)
  '0x1F', '0b1010', '0o755',
  // float/科学计数
  '1.5', '.5', '1.', '1e3', '1.5E-3', '-2.5',
  // bool 1.1 全家(true/false 系 + y/n 系 + on/off 系,各大小写变体)
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO',
  'on', 'On', 'ON', 'off', 'Off', 'OFF',
  // null
  '~', 'null', 'Null', 'NULL',
  // inf/nan
  '.inf', '.Inf', '.INF', '-.inf', '.nan', '.NaN', '.NAN',
  // timestamp(yaml.v2 解析后经 sigs.k8s.io/yaml 转 JSON 会改写成 RFC3339——静默损坏)
  '2026-08-16', '2026-08-16T10:00:00Z', '2026-08-16 10:00:00',
]

// 这些值任何 YAML 方言都按字符串解析——保持裸值,不加引号(YAML 可读性)。
const SAFE = ['10m', '4k', '60s', 'web', 'HTTP', 'round_robin', '1.2.3', 'no-cache', 'on-demand', '0.0.0.0/0']

describe('yamlScalar: YAML 1.1 隐式类型化防线', () => {
  for (const v of DANGEROUS) {
    it(`危险值 ${JSON.stringify(v)} → 双引号包裹`, () => {
      const out = yamlScalar(v)
      expect(out.startsWith('"') && out.endsWith('"')).toBe(true)
      // 引号内即原值(双引号 YAML 转义后 round-trip 须还原)
      expect(yamlLoad(`k: ${out}`).k).toBe(v)
    })
  }
  for (const v of SAFE) {
    it(`安全值 ${JSON.stringify(v)} → 保持裸值`, () => {
      expect(yamlScalar(v)).toBe(v)
    })
  }

  it('换行值仍走 block scalar(|-),不受本修复影响', () => {
    expect(yamlScalar('a\nb')).toBe('|-\n      a\n      b')
  })
})

describe('generateYAML(ingress): 注解值经真 YAML 解析后必须是字符串(线上事故回归)', () => {
  it('proxy-send-timeout=3600 / ssl-redirect=true / hsts-max-age=31536000', () => {
    const yaml = store.generateYAML('ingress', {
      name: 'aliangboard', namespace: 'aliangboard',
      annotations: {
        'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600',
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
        'nginx.ingress.kubernetes.io/hsts-max-age': '31536000',
      },
      rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'app-svc', servicePort: 80 } }] } }],
    })
    // 源码级断言:危险值必须带引号(js-yaml 1.2 对 yes/on 系宽松,round-trip 抓不全)
    expect(yaml).toContain('nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"')
    expect(yaml).toContain('nginx.ingress.kubernetes.io/ssl-redirect: "true"')
    // 行为级断言:真实 YAML 解析器读回,注解值类型必须是 string
    const obj = yamlLoad(yaml)
    const ann = obj.metadata.annotations
    for (const k of Object.keys(ann)) expect(typeof ann[k]).toBe('string')
    expect(ann['nginx.ingress.kubernetes.io/proxy-send-timeout']).toBe('3600')
  })
})
