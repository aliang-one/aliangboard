// 第三资源键保全(2026-10-11 工作流审计 B1/B2/#10 根修配套):
// cpu/memory 之外的资源键(ephemeral-storage、nvidia.com/gpu、resources.claims)曾在
// 编辑保存/复制两条链被白名单重建静默删除(merge-patch 整组下发,apiserver 不报错)。
// 机制:pickExtraResources 反解时携带第三键 → mergeResources 重建时合并回去;
// 编辑面另走 opts.base(原容器克隆叠加)保全容器级未建模字段(terminationMessagePath 等)。
import { describe, it, expect } from 'vitest'
import { mapSubContainer, buildSubContainerSpec, makeSubContainer, mergeResources, pickExtraResources } from '@/logic/subContainer'

describe('pickExtraResources: resources 里 cpu/memory 之外的键', () => {
  it('抽取第三键,剔除 cpu/memory', () => {
    expect(pickExtraResources({ limits: { cpu: '1', memory: '1Gi', 'nvidia.com/gpu': '1', 'ephemeral-storage': '1Gi' } }))
      .toEqual({ limits: { 'nvidia.com/gpu': '1', 'ephemeral-storage': '1Gi' } })
  })
  it('resources 级其他键(claims)保留', () => {
    expect(pickExtraResources({ claims: [{ name: 'c1' }], requests: { cpu: '100m' } }))
      .toEqual({ claims: [{ name: 'c1' }] })
  })
  it('无第三键 / 无 resources → null', () => {
    expect(pickExtraResources({ requests: { cpu: '100m' }, limits: { memory: '1Gi' } })).toBe(null)
    expect(pickExtraResources(null)).toBe(null)
    expect(pickExtraResources({})).toBe(null)
  })
})

describe('mergeResources: 表单四键权威 + 第三键/base 保全 + 删除语义', () => {
  it('base null + 四值 → 全新 resources(创建面语义不变)', () => {
    expect(mergeResources(null, { cpuRequest: '250m', cpuLimit: '500m', memoryRequest: '256Mi', memoryLimit: '512Mi' }))
      .toEqual({ requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } })
  })
  it('base 含第三键 → 表单值覆盖 cpu/memory,第三键原样保留', () => {
    const base = { limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' } }
    expect(mergeResources(base, { cpuRequest: '', cpuLimit: '2', memoryRequest: '', memoryLimit: '4Gi' }))
      .toEqual({ limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '1Gi' } })
  })
  it('base 有 cpu、表单清空 → requests:null 显式删(merge-patch 删除语义)', () => {
    expect(mergeResources({ requests: { cpu: '250m' } }, { cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }))
      .toEqual({ requests: null })
  })
  it('base null + 全空 → null(无 resources 不凭空长)', () => {
    expect(mergeResources(null, { cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' })).toBe(null)
  })
  it('base 仅第三键 + 表单全空 → 第三键保留(不整删 resources)', () => {
    expect(mergeResources({ claims: [{ name: 'c1' }] }, { cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }))
      .toEqual({ claims: [{ name: 'c1' }] })
  })
  it('深拷贝:不改动入参 base', () => {
    const base = { limits: { cpu: '1' } }
    mergeResources(base, { cpuRequest: '', cpuLimit: '9', memoryRequest: '', memoryLimit: '' })
    expect(base).toEqual({ limits: { cpu: '1' } })
  })
})

describe('buildSubContainerSpec: extraResources/base 保全链', () => {
  it('extraResources 第三键随重建输出(复制链)', () => {
    const spec = buildSubContainerSpec({
      name: 'sc', image: 'nginx', cpuRequest: '', cpuLimit: '1', memoryRequest: '', memoryLimit: '',
      extraResources: { limits: { 'nvidia.com/gpu': '1' } },
    })
    expect(spec.resources).toEqual({ limits: { cpu: '1', 'nvidia.com/gpu': '1' } })
  })
  it('opts.base 容器级未建模字段保留 + resources 第三键保留(编辑链)', () => {
    const base = {
      name: 'sc', image: 'nginx:old', terminationMessagePath: '/dev/custom-log',
      resizePolicy: [{ resourceName: 'cpu', restartPolicy: 'NotRequired' }],
      resources: { limits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '1Gi' } },
    }
    const c = mapSubContainer(base)
    c.image = 'nginx:new'
    c.cpuLimit = ''
    c.memoryLimit = ''
    const spec = buildSubContainerSpec(c, { nullAbsent: true, base })
    expect(spec.image).toBe('nginx:new')
    expect(spec.terminationMessagePath).toBe('/dev/custom-log')        // 未建模字段不丢
    expect(spec.resizePolicy).toEqual(base.resizePolicy)               // 未建模字段不丢
    expect(spec.resources).toEqual({ limits: { 'ephemeral-storage': '1Gi' } }) // 清空的 cpu/memory 删、第三键留
  })
  it('nullAbsent 且无任何资源 → resources:null(显式删,语义不变)', () => {
    const spec = buildSubContainerSpec({ name: 'sc', image: 'nginx', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }, { nullAbsent: true })
    expect(spec.resources).toBe(null)
  })
  it('mapSubContainer → buildSubContainerSpec 往返:第三键不丢', () => {
    const raw = { name: 'sc', image: 'nginx', resources: { requests: { cpu: '100m' }, limits: { cpu: '1', 'nvidia.com/gpu': '1' } } }
    const roundtrip = buildSubContainerSpec(mapSubContainer(raw))
    expect(roundtrip.resources).toEqual({ requests: { cpu: '100m' }, limits: { cpu: '1', 'nvidia.com/gpu': '1' } })
  })
})

describe('base 子对象级合并(审查修复):lifecycle/securityContext/volumeMounts 未建模子键保真', () => {
  it('lifecycle:httpGet 钩子表单不可表达 → 保真;exec 钩子被清空 → 删', () => {
    const base = { name: 'sc', image: 'nginx', lifecycle: { preStop: { httpGet: { path: '/stop' } }, postStart: { exec: { command: ['old'] } } } }
    const c = mapSubContainer(base)   // postStart 回填 'old',preStop httpGet 表单为空
    c.lifecycle.postStart = ''        // 用户清空 exec 钩子
    const spec = buildSubContainerSpec(c, { nullAbsent: true, base })
    expect(spec.lifecycle).toEqual({ preStop: { httpGet: { path: '/stop' } } })
  })
  it('securityContext:seccompProfile 保真;用户整体关闭 → 整删', () => {
    const base = { name: 'sc', image: 'nginx', securityContext: { seccompProfile: { type: 'RuntimeDefault' }, runAsUser: 1000 } }
    const c = mapSubContainer(base)
    const spec = buildSubContainerSpec(c, { nullAbsent: true, base })
    expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' }, runAsUser: 1000 })
    c.securityContext.enabled = false   // 用户关闭
    const spec2 = buildSubContainerSpec(c, { nullAbsent: true, base })
    expect(spec2.securityContext).toBe(null)
  })
  it('volumeMounts:mountPropagation 从 base 同名挂载保真', () => {
    const base = { name: 'sc', image: 'nginx', volumeMounts: [{ name: 'v1', mountPath: '/a', mountPropagation: 'HostToContainer' }] }
    const c = mapSubContainer(base)
    const spec = buildSubContainerSpec(c, { nullAbsent: true, base, mounts: [{ name: 'v1', mountPath: '/a' }] })
    expect(spec.volumeMounts).toEqual([{ mountPropagation: 'HostToContainer', name: 'v1', mountPath: '/a' }])
  })
})

describe('origName 行溯源(审查修复):改名行保 base、新建行不复活已删容器', () => {
  it('mapSubContainer 带 origName;makeSubContainer 空', () => {
    expect(mapSubContainer({ name: 'envoy', image: 'x' }).origName).toBe('envoy')
    expect(makeSubContainer().origName).toBe('')
  })
  it('改名行按 origName 命中 base:未建模字段随行迁移到新名', () => {
    const base = { name: 'envoy', image: 'envoy:1', terminationMessagePath: '/dev/custom' }
    const c = mapSubContainer(base)
    c.name = 'envoy-renamed'
    const spec = buildSubContainerSpec(c, { nullAbsent: true, base })
    expect(spec.name).toBe('envoy-renamed')
    expect(spec.terminationMessagePath).toBe('/dev/custom')
  })
  // 新建行(origName='')不带 base 的裁决在 NsWorkloadDetail.saveEdit 的 baseOf(按 origName 溯源),
  // 由 NsWorkloadDetail.resources-save.test.js 的视图用例锁定——本层无从置喙。
})
