// 元数据编辑的 selector 承重墙防线(2026-08-19 线上事故:ai-gateway)。
// 根因:Kuboard 创建的 Deployment selector 绑定 k8s.kuboard.cn/layer=svc(不可变);
// 元数据编辑器把该键当普通自定义标签展示 → 用户改值 svc→gateway → saveMeta 镜像写入
// Pod 模板 labels → selector ⊄ template → K8s 422「selector does not match template labels」。
// 防线:①自定义列表隐藏 selector 键 ②保存前拦截撞键行 ③模板镜像对 selector 键强制原值透传。
import { describe, test, expect } from 'vitest'
import { selectorMatchLabels, findSelectorLabelConflict, guardTemplateLabels } from '../workloadMeta.js'

const KUBOARD_DEPLOY = {
  spec: {
    selector: { matchLabels: { 'k8s.kuboard.cn/layer': 'svc', 'k8s.kuboard.cn/name': 'ai-gateway' } },
    template: { metadata: { labels: {
      'k8s.kuboard.cn/layer': 'svc', 'k8s.kuboard.cn/name': 'ai-gateway', 'pod-template-hash': '6c6cfcc5b5',
    } } },
  },
}

describe('selectorMatchLabels:从 raw 提取 selector 绑定键', () => {
  test('Deployment/StatefulSet/DaemonSet 的 spec.selector.matchLabels', () => {
    expect(selectorMatchLabels(KUBOARD_DEPLOY)).toEqual({ 'k8s.kuboard.cn/layer': 'svc', 'k8s.kuboard.cn/name': 'ai-gateway' })
  })
  test('无 selector / 无 matchLabels / raw 缺失 → 空 map(不炸)', () => {
    expect(selectorMatchLabels(null)).toEqual({})
    expect(selectorMatchLabels({})).toEqual({})
    expect(selectorMatchLabels({ spec: { selector: {} } })).toEqual({})
    expect(selectorMatchLabels({ spec: { selector: { matchLabels: null } } })).toEqual({})
  })
})

describe('findSelectorLabelConflict:自定义标签行撞 selector 键', () => {
  const sel = selectorMatchLabels(KUBOARD_DEPLOY)
  test('撞键(含首尾空格/大小写敏感)→ 返回该行', () => {
    const rows = [{ key: 'team', value: 'a' }, { key: ' k8s.kuboard.cn/layer ', value: 'gateway' }]
    expect(findSelectorLabelConflict(rows, sel)).toBe(rows[1])
  })
  test('无撞键 → null;空 key 行忽略', () => {
    expect(findSelectorLabelConflict([{ key: 'team', value: 'a' }, { key: '', value: '' }], sel)).toBe(null)
    expect(findSelectorLabelConflict([], sel)).toBe(null)
  })
})

describe('guardTemplateLabels:模板镜像对 selector 键强制原值透传', () => {
  const sel = selectorMatchLabels(KUBOARD_DEPLOY)
  const rawTpl = KUBOARD_DEPLOY.spec.template.metadata.labels
  test('用户改了 selector 键值(svc→gateway)→ 压回原值 svc(K8s 不再 422)', () => {
    const desired = { ...rawTpl, 'k8s.kuboard.cn/layer': 'gateway', 'aliangboard.io/layer': 'gateway', 'layer.aliangboard.io': 'gateway' }
    const guarded = guardTemplateLabels(desired, rawTpl, sel)
    expect(guarded['k8s.kuboard.cn/layer']).toBe('svc', 'selector 键强制原值')
    expect(guarded['k8s.kuboard.cn/name']).toBe('ai-gateway')
    expect(guarded['aliangboard.io/layer']).toBe('gateway', '非 selector 键照常透传(业务标签不受影响)')
  })
  test('business 键撞 selector 键(极端:selector 绑 layer.aliangboard.io)→ 同样压回原值', () => {
    const sel2 = { 'layer.aliangboard.io': 'web' }
    const raw2 = { 'layer.aliangboard.io': 'web', app: 'x' }
    const guarded = guardTemplateLabels({ ...raw2, 'layer.aliangboard.io': 'gateway' }, raw2, sel2)
    expect(guarded['layer.aliangboard.io']).toBe('web')
  })
  test('模板上不存在的 selector 键(理论不可达的脏数据)→ 不注入;无 selector → 原样返回', () => {
    const guarded = guardTemplateLabels({ a: '1' }, { a: '1' }, { ghost: 'g' })
    expect(guarded).toEqual({ a: '1' })
    expect(guardTemplateLabels({ a: '1' }, { a: '1' }, {})).toEqual({ a: '1' })
  })
})
