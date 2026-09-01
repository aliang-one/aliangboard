// 元数据编辑的 selector 承重墙防线(2026-08-19 线上事故:ai-gateway)。
// 根因:Kuboard 创建的 Deployment selector 绑定 k8s.kuboard.cn/layer=svc(不可变);
// 元数据编辑器把该键当普通自定义标签展示 → 用户改值 svc→gateway → saveMeta 镜像写入
// Pod 模板 labels → selector ⊄ template → K8s 422「selector does not match template labels」。
// 防线:①自定义列表隐藏 selector 键 ②保存前拦截撞键行 ③模板镜像对 selector 键强制原值透传。
import { describe, test, expect } from 'vitest'
import { selectorMatchLabels, findSelectorLabelConflict, guardTemplateLabels, templateSelectorBreaks, identitySelector, servicesBrokenBy, applyLabelPatch, consumersBrokenBy } from '../workloadMeta.js'

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

describe('templateSelectorBreaks:模板 YAML 编辑器防线(改 selector 键值 → K8s 422)', () => {
  const sel = { 'k8s.kuboard.cn/layer': 'svc', app: 'ai-gateway' }
  test('selector 键在新模板 labels 中值被改 → 返回冲突键', () => {
    const tplLabels = { 'k8s.kuboard.cn/layer': 'gateway', app: 'ai-gateway', team: 'x' }
    expect(templateSelectorBreaks(tplLabels, sel)).toEqual(['k8s.kuboard.cn/layer'])
  })
  test('值一致 / 键未提及(merge-patch 不删键,删行无害) → 通过(空数组)', () => {
    expect(templateSelectorBreaks({ app: 'ai-gateway' }, sel)).toEqual([])
    expect(templateSelectorBreaks({}, sel)).toEqual([])
    expect(templateSelectorBreaks(null, sel)).toEqual([])
  })
  test('值类型差异按字符串比较(selector 数字/标签字符串)', () => {
    expect(templateSelectorBreaks({ app: 'ai-gateway' }, { app: 'ai-gateway' })).toEqual([])
    expect(templateSelectorBreaks({ replicas: '2' }, { replicas: 2 })).toEqual([])
    expect(templateSelectorBreaks({ replicas: '3' }, { replicas: 2 })).toEqual(['replicas'])
  })
  test('无 selector → 恒通过', () => {
    expect(templateSelectorBreaks({ any: 'thing' }, {})).toEqual([])
  })
})

// === Service selector 身份化 + 失配防线(2026-09-01 Ingress 503 事故) ===
// saveExpose 曾把暴露时刻全部模板 labels 快照进 Service selector;元数据编辑器镜像改动
// 业务标签 → Pod labels 变 → Service 失配 → Endpoints 空 → Ingress 503(全程静默)。

describe('identitySelector:身份 selector(Deployment selector ∩ 模板 + app 系身份标签)', () => {
  test('kuboard selector + app 并存:selector 键 + app,业务标签(pod-template-hash 等)不进', () => {
    const tpl = { ...KUBOARD_DEPLOY.spec.template.metadata.labels, app: 'ai-gateway', 'aliangboard.io/version': 'v1' }
    expect(identitySelector(KUBOARD_DEPLOY, tpl)).toEqual({
      'k8s.kuboard.cn/layer': 'svc', 'k8s.kuboard.cn/name': 'ai-gateway', app: 'ai-gateway',
    })
  })
  test('selector 已绑定 app → 不重复添加', () => {
    const raw = { spec: { selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } } } } }
    expect(identitySelector(raw, { app: 'web' })).toEqual({ app: 'web' })
  })
  test('selector 键不在模板(脏数据)→ 只留交集', () => {
    const raw = { spec: { selector: { matchLabels: { a: '1', ghost: '2' } } } }
    expect(identitySelector(raw, { a: '1' })).toEqual({ a: '1' })
  })
  test('值不等(脏数据)→ 该键不进(保证 selector ⊆ 模板)', () => {
    const raw = { spec: { selector: { matchLabels: { a: '1' } } } }
    expect(identitySelector(raw, { a: '9' })).toEqual({})
  })
  test('app.kubernetes.io/name 作为身份标签补位', () => {
    expect(identitySelector({}, { 'app.kubernetes.io/name': 'api' })).toEqual({ 'app.kubernetes.io/name': 'api' })
  })
  test('业务标签永不算身份:模板只有自定义标签 → 空 map(调用方拦截)', () => {
    expect(identitySelector({}, { team: 'x', 'aliangboard.io/version': 'v1' }, 'web')).toEqual({})
  })
  test('模板为空(legacy 扁平数据)→ 回退 {app: fallbackName}', () => {
    expect(identitySelector(null, {}, 'web')).toEqual({ app: 'web' })
    expect(identitySelector(null, null, 'web')).toEqual({ app: 'web' })
  })
  test('全空输入 → 空 map', () => {
    expect(identitySelector(null, {}, '')).toEqual({})
  })
  test('值一律 String 化', () => {
    expect(identitySelector({}, { app: 123 })).toEqual({ app: '123' })
  })
})

describe('servicesBrokenBy:模板 labels 变更会失配的 Service 名单', () => {
  test('值漂移 / 键缺失 → 失配;匹配 / 空 selector → 通过', () => {
    const svcs = [
      { name: 'ok-svc', selector: { app: 'v2' } },
      { name: 'drift-svc', selector: { app: 'v1' } },
      { name: 'gone-key-svc', selector: { app: 'v2', team: 'a' } },
      { name: 'empty-svc', selector: {} },
      { name: 'no-sel-svc', selector: null },
    ]
    expect(servicesBrokenBy({ app: 'v2' }, svcs)).toEqual(['drift-svc', 'gone-key-svc'])
  })
  test('全匹配 → 空数组', () => {
    const svcs = [
      { name: 'ok-svc', selector: { app: 'web' } },
      { name: 'gone-key-svc', selector: { app: 'web', team: 'a' } },
    ]
    expect(servicesBrokenBy({ app: 'web', team: 'a' }, svcs)).toEqual([])
  })
  test('值按字符串比较(标签本就是字符串)', () => {
    expect(servicesBrokenBy({ app: 2 }, [{ name: 's', selector: { app: '2' } }])).toEqual([])
    expect(servicesBrokenBy({ app: 3 }, [{ name: 's', selector: { app: '2' } }])).toEqual(['s'])
  })
  test('services 缺失 / 空 → 空数组(不炸)', () => {
    expect(servicesBrokenBy({ app: 'x' }, null)).toEqual([])
    expect(servicesBrokenBy({ app: 'x' }, [])).toEqual([])
  })
})

describe('applyLabelPatch:merge-patch 语义求补后 labels', () => {
  test('覆写 + 未提及键保留', () => {
    expect(applyLabelPatch({ app: 'v1', team: 'x' }, { app: 'v2' })).toEqual({ app: 'v2', team: 'x' })
  })
  test('null 删键', () => {
    expect(applyLabelPatch({ app: 'v1', team: 'x' }, { team: null })).toEqual({ app: 'v1' })
  })
  test('不改入参', () => {
    const base = { app: 'v1' }
    applyLabelPatch(base, { app: 'v2' })
    expect(base).toEqual({ app: 'v1' })
  })
  test('patch 缺失 → 原 map 浅拷贝', () => {
    expect(applyLabelPatch({ app: 'v1' }, null)).toEqual({ app: 'v1' })
    expect(applyLabelPatch(null, { app: 'v1' })).toEqual({ app: 'v1' })
  })
})

describe('consumersBrokenBy:这次 labels 变更会拆掉的消费者(编辑面守卫④,精度版)', () => {
  // 与 servicesBrokenBy 的分工:守卫只拦「当前正匹配本负载(selector ⊆ old)且改后将不匹配(⊄ new)」
  // 的消费者——从不匹配本负载的无关对象(selector app: other)不是这次编辑拆的,不得误拦。
  const consumers = [
    { kind: 'Service', name: 'matched-svc', selector: { app: 'web', team: 'red' } },
    { kind: 'Service', name: 'unrelated-svc', selector: { app: 'other' } },
    { kind: 'PDB', name: 'pdb-drift', selector: { app: 'web', team: 'red' } },
    { kind: 'NetworkPolicy', name: 'np-keep', selector: { app: 'web' } },
    { kind: 'Service', name: 'empty-svc', selector: {} },
  ]
  test('正匹配且将失配 → 列出 kind/name;从未匹配 → 排除(精度缺口回归锁)', () => {
    expect(consumersBrokenBy({ app: 'web', team: 'red' }, { app: 'web', team: 'blue' }, consumers))
      .toEqual([
        { kind: 'Service', name: 'matched-svc' },
        { kind: 'PDB', name: 'pdb-drift' },
      ])
  })
  test('改后仍匹配 → 排除;键缺失同判', () => {
    expect(consumersBrokenBy({ app: 'web', team: 'red' }, { app: 'web' }, [
      { kind: 'NetworkPolicy', name: 'np-keep', selector: { app: 'web' } },
      { kind: 'PDB', name: 'gone-key', selector: { app: 'web', team: 'red' } },
    ])).toEqual([{ kind: 'PDB', name: 'gone-key' }])
  })
  test('值按字符串比较', () => {
    expect(consumersBrokenBy({ app: 2 }, { app: 3 }, [{ kind: 'Service', name: 's', selector: { app: '2' } }]))
      .toEqual([{ kind: 'Service', name: 's' }])
  })
  test('consumers 缺失 / old 缺失 → 空数组(不炸;old 缺失=无当前匹配,无从拆起)', () => {
    expect(consumersBrokenBy({ app: 'web' }, { app: 'x' }, null)).toEqual([])
    expect(consumersBrokenBy(null, { app: 'x' }, consumers)).toEqual([])
  })
})
