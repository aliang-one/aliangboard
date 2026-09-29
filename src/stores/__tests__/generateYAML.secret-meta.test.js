import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

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
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })

describe('generateYAML secret meta', () => {
  it('labels/annotations 写入 metadata（stringData 保持明文）', () => {
    const y = store.generateYAML('secret', {
      name: 's1', namespace: 'default', type: 'Opaque',
      data: { token: btoa('abc') },                    // gen 内部 decodeBase64 后写 stringData
      labels: { app: 'x' }, annotations: { note: 'n1' },
    })
    const o = yamlLoad(y)
    expect(o.metadata.labels).toEqual({ app: 'x' })
    expect(o.metadata.annotations).toEqual({ note: 'n1' })
    expect(o.stringData).toEqual({ token: 'abc' })
    expect(o.type).toBe('Opaque')
  })

  it('无 labels/annotations 时不输出空块（输出与旧行为逐字一致）', () => {
    const y = store.generateYAML('secret', { name: 's2', namespace: 'default', type: 'Opaque', data: {} })
    expect(y).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: "s2"
  namespace: "default"
type: Opaque
stringData:
  {}`)
  })

  // 系统审计(2026-09-29):非 UTF-8(二进制)secret 值的 decodeBase64 catch-fallback 会把
  // 仍是 base64 态的原串当明文写进 stringData → apiserver 再编码一次 = 双重编码(issue#15
  // 的二进制子集,1194b75b 未覆盖)。修复:解码失败的键原样留在 data:(base64 态),
  // 可解码的键走 stringData(明文)——K8s 允许两块并存(键不重叠)。
  it('二进制(非 UTF-8)值留在 data: 原样 base64,文本值走 stringData 明文——不双重编码', () => {
    const bin = String.fromCharCode(0xff, 0xfe, 0x01, 0x02) // 非 UTF-8 字节序列
    const binB64 = btoa(bin)
    const y = store.generateYAML('secret', {
      name: 's3', namespace: 'default', type: 'Opaque',
      data: { 'keystore.p12': binB64, password: btoa('test123') },
    })
    const o = yamlLoad(y)
    // 文本键:单编码(stringData 明文,apiserver 编一次)
    expect(o.stringData).toEqual({ password: 'test123' })
    // 二进制键:原 base64 原样落 data:,apiserver 不再编码 → 集群值不变
    expect(o.data).toEqual({ 'keystore.p12': binB64 })
  })

  it('全文本 secret 不输出 data: 块(与既有输出形态逐字一致,不惊扰既有消费方)', () => {
    const y = store.generateYAML('secret', { name: 's4', namespace: 'default', type: 'Opaque', data: { password: btoa('test123') } })
    expect(y).not.toContain('\ndata:')
    expect(yamlLoad(y).stringData).toEqual({ password: 'test123' })
  })
})
