// 测试基线脚本（零外部依赖的极简运行器）
//
// 非目标禁止新增外部依赖，因此这里用一个极简的自包含测试运行器建立「测试基线」：
// 后续任务可直接在此文件追加用例（或新增 *.test.mjs 并 import），无需引入 vitest/jest。
// 用例选取贴近本仓库真实链路：
//   - Secret 数据的 base64 编解码（与 stores/cluster.js 的 encodeSecretData 行为一致）；
//   - apply 链路依赖的 YAML 往返（使用仓库已声明的 js-yaml 依赖，非新增）。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classifyResource, groupByLayer } from '../src/composables/useLayering.js'
import { buildIngressAnnotations, detectDialect, dialectGroups, dialectHint, INGRESS_DIALECTS, PERF_GROUPS } from '../src/composables/useIngressPerf.js'
import { yamlScalar, dumpResourceYaml } from '../src/composables/useYaml.js'
import { load } from 'js-yaml'
import { shortenRuntime, normalizeTaints, extractNodeExtra } from '../src/composables/useNodeFields.js'
import { cpuToMilli, milliToCpu, memToKi, formatCpu, formatMem } from '../src/composables/useResourceFormat.js'
import { workloadToForm } from '../src/composables/useWorkloadToForm.js'
import { STORAGE_CLASS_PRESETS, STORAGE_CLASS_PRESET_FAMILIES, paramsMapToRows, paramsRowsToMap, normalizeParamsToMap, hasPlaceholderParam, presetToFormState } from '../src/data/storageClassPresets.js'
import { buildStorageClassYaml } from '../src/data/storageClassYaml.js'
import { emptySelector, emptyPeer, emptyPort, emptyIngressRule, emptyEgressRule, defaultModel, consequence, isDenyAll, modelToYaml, parseAndValidate } from '../src/logic/networkPolicy.js'
import { migrateV1toV2, reconcileColumns, STORAGE_KEY, STORAGE_KEY_V1 } from '../src/composables/tableColumnsCore.js'
import { formatBytes, parseSizeToBytes } from '../src/utils/bytes.js'
import { splitCommandTokens, splitArgLines, joinCommandTokens } from '../src/utils/containerTokens.js'
import { deriveClusterCounts } from '../src/logic/clusterCounts.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, err })
  }
}

// --- Secret 数据 base64 往返（Node 内置 Buffer，镜像 encodeSecretData） ---
test('Secret 数据 base64 编解码可无损往返', () => {
  const encode = (obj) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Buffer.from(String(v), 'utf8').toString('base64')]))
  const decode = (obj) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Buffer.from(String(v), 'base64').toString('utf8')]))
  const original = { USERNAME: 'admin', PASSWORD: 'p@ss-w0rd', 多行: '行1\n行2' }
  assert.deepEqual(decode(encode(original)), original)
})

// --- YAML 往返（仓库已声明 js-yaml 依赖，覆盖 apply 链路核心） ---
test('js-yaml 可正确加载并回写 YAML（apply 链路核心依赖）', async () => {
  const mod = await import('js-yaml')
  const yaml = mod.default ?? mod
  const doc = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm-baseline' }, data: { key: 'value' } }
  const dumped = yaml.dump(doc)
  const loaded = yaml.load(dumped)
  assert.equal(loaded.kind, 'ConfigMap')
  assert.equal(loaded.metadata.name, 'cm-baseline')
  assert.equal(loaded.data.key, 'value')
})

// --- 仓库 package.json 可解析且含必备脚本（防止基线脚本被误删） ---
test('package.json 可解析且包含 build/typecheck/test 脚本', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts, 'package.json 应包含 scripts')
  for (const key of ['build', 'typecheck', 'test']) {
    assert.ok(typeof pkg.scripts[key] === 'string' && pkg.scripts[key].length, `缺少脚本: ${key}`)
  }
})

// --- K8s 资源量解析（现从 useResourceFormat 直接 import，无需镜像）---
test('K8s 资源量解析：CPU→毫核、内存→Ki（覆盖各后缀与裸值）', () => {
  // CPU：毫核 / 核 / 纳核 / 微核 / 空值
  assert.equal(cpuToMilli('500m'), 500)
  assert.equal(cpuToMilli('2'), 2000)
  assert.equal(cpuToMilli('868940n'), 1)      // 纳核 → 0.87m，四舍五入为 1m
  assert.equal(cpuToMilli('750u'), 1)         // 微核 → 0.75m，四舍五入为 1m
  assert.equal(cpuToMilli(''), 0)
  assert.equal(cpuToMilli(null), 0)
  // 内存：Ki/Mi/Gi/裸字节
  assert.equal(memToKi('1Gi'), 1024 ** 2)
  assert.equal(memToKi('512Mi'), 512 * 1024)
  assert.equal(memToKi('1024'), 1)            // 裸字节 → 1024 B = 1 Ki
})

test('CPU 毫核→K8s quantity(milliToCpu)+ 往返稳定', () => {
  assert.equal(milliToCpu(20000), '20000m')
  assert.equal(milliToCpu(500), '500m')
  assert.equal(milliToCpu(0), '0m')
  assert.equal(milliToCpu(''), '')
  assert.equal(milliToCpu(null), '')
  assert.equal(milliToCpu(undefined), '')
  // 往返:毫核 → quantity → 毫核
  assert.equal(cpuToMilli(milliToCpu(20000)), 20000)
  assert.equal(cpuToMilli(milliToCpu(500)), 500)
  // K8s 规范化("20" cores 或 "20000m")都能还原为同一毫核值
  assert.equal(cpuToMilli('20'), 20000)
  assert.equal(cpuToMilli('20000m'), 20000)
})

test('用量格式化：CPU→毫核串、内存→Ti/Gi/Mi 降级、空值→—', () => {
  assert.equal(formatCpu(500), '500m')
  assert.equal(formatCpu(null), '—')
  assert.equal(formatMem(1024), '1Mi')
  assert.equal(formatMem(1024 ** 2), '1Gi')
  assert.equal(formatMem(1024 ** 3), '1Ti')
  assert.equal(formatMem(null), '—')
})

// --- Namespace 应用分层：归类契约（label 权威 > 名称/镜像启发式 > 默认）---
test('应用分层 classifyResource：label 覆盖、启发式、默认（业务/杂项）', () => {
  // label 权威覆盖
  assert.equal(classifyResource({ name: 'anything', labels: { 'layer.aliangboard.io': 'storage' } }), 'storage')
  assert.equal(classifyResource({ name: 'x', annotations: { 'layer.aliangboard.io': 'microservice/support' } }), 'microservice-support')
  assert.equal(classifyResource({ name: 'x', labels: { layer: 'gateway' } }), 'gateway')
  // 启发式：名称 / 镜像
  assert.equal(classifyResource({ name: 'api-gateway', image: 'nginx:1.25' }), 'gateway')
  assert.equal(classifyResource({ name: 'redis-cache', image: 'redis:7' }), 'middleware')
  assert.equal(classifyResource({ name: 'mysql-primary', image: 'mysql:8' }), 'persistence')
  assert.equal(classifyResource({ name: 'prometheus-server' }), 'monitoring')
  assert.equal(classifyResource({ name: 'frontend-web', image: 'node:18' }), 'presentation')
  // 默认：普通工作负载 → 业务；Job/CronJob → 杂项
  assert.equal(classifyResource({ name: 'order-service', type: 'Deployment' }), 'microservice-business')
  assert.equal(classifyResource({ name: 'cleanup-job', type: 'CronJob' }), 'microservice-misc')
  // 未知 label 值 → 未分类
  assert.equal(classifyResource({ name: 'x', labels: { 'layer.aliangboard.io': 'galaxy' } }), 'unclassified')
})

test('应用分层 groupByLayer：microservice 展开为子层、空层被过滤', () => {
  const groups = groupByLayer([
    { name: 'order-service', type: 'Deployment' },
    { name: 'cleanup-job', type: 'CronJob' },
    { name: 'redis', image: 'redis:7' },
  ])
  const keys = groups.map(g => g.key)
  assert.ok(keys.includes('middleware') && keys.includes('microservice'), '应含中间件与微服务层')
  const ms = groups.find(g => g.key === 'microservice')
  const subKeys = ms.children.map(c => c.key)
  assert.ok(subKeys.includes('microservice-business') && subKeys.includes('microservice-misc'), '微服务层应含业务与杂项子层')
  assert.equal(ms.children.find(c => c.key === 'microservice-business').items.length, 1)
  assert.ok(!keys.includes('storage'), '无资源的层不应出现')
})

// --- Ingress 创建：性能参数 → nginx 注解（直接测共享 buildIngressAnnotations）---
test('Ingress 性能参数注解：非空写入 nginx.ingress.kubernetes.io/*、空值忽略、自定义合并', () => {
  const ann = buildIngressAnnotations(
    'nginx',
    { 'proxy-read-timeout': '60', 'limit-rps': '   ', 'load-balance': 'least_conn' },
    [{ key: 'nginx.ingress.kubernetes.io/rewrite-target', value: '/$1' }, { key: '', value: 'x' }]
  )
  assert.equal(ann['nginx.ingress.kubernetes.io/proxy-read-timeout'], '60')
  assert.equal(ann['nginx.ingress.kubernetes.io/load-balance'], 'least_conn')
  assert.ok(!('nginx.ingress.kubernetes.io/limit-rps' in ann), '空值不应写入')
  assert.equal(ann['nginx.ingress.kubernetes.io/rewrite-target'], '/$1')
  assert.equal(Object.keys(ann).length, 3)
})

// --- Ingress 注解 YAML 转义：多行 snippet / 反斜杠 / 双引号经 yamlScalar 后 js-yaml 可往返 ---
// 回归：server-snippet（多行原始 nginx 配置）、含反斜杠的值、含双引号的值曾因裸 "${v}" 包裹而损坏 YAML，
// 导致 generateYAML('ingress') / DeployApp 向导生成的 Ingress apply 失败。
test('Ingress 注解 YAML 转义：多行 / 反斜杠 / 双引号经 yamlScalar 后 js-yaml 完整往返；空值自定义跳过', () => {
  const ann = buildIngressAnnotations(
    'nginx',
    { 'server-snippet': '# line one\nproxy_read_timeout 300;\n# regex \\d and "quote"' },
    [{ key: 'custom.example/plain', value: 'plain' }, { key: 'custom.example/empty', value: '' }]
  )
  assert.ok(!('custom.example/empty' in ann), '空值自定义注解应被跳过')
  // 复刻 generateYAML('ingress') 的注解序列化：`    ${k}: ${scalar(v)}`（scalar === yamlScalar）
  const annYaml = Object.entries(ann).map(([k, v]) => `    ${k}: ${yamlScalar(v)}`).join('\n')
  const doc = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: x
  annotations:
${annYaml}`
  const out = load(doc).metadata.annotations
  assert.equal(out['nginx.ingress.kubernetes.io/server-snippet'], '# line one\nproxy_read_timeout 300;\n# regex \\d and "quote"')
  assert.equal(out['custom.example/plain'], 'plain')
})

// --- 调优方言:detectDialect 用例表 ---
test('detectDialect: 类名子串识别,未知/空 → generic', () => {
  assert.equal(detectDialect('nginx'), 'nginx')
  assert.equal(detectDialect('ingress-nginx'), 'nginx')
  assert.equal(detectDialect('Traefik'), 'traefik')   // 大小写不敏感
  assert.equal(detectDialect('my-haproxy'), 'haproxy')
  assert.equal(detectDialect('kong'), 'kong')
  assert.equal(detectDialect('istio'), 'generic')
  assert.equal(detectDialect(''), 'generic')
})

test('buildIngressAnnotations: haproxy/traefik/kong 各按自己的前缀拼键', () => {
  const h = buildIngressAnnotations('haproxy', { 'timeout-connect': '5s' }, [])
  assert.equal(h['haproxy-ingress.github.io/timeout-connect'], '5s')
  const h2 = buildIngressAnnotations('haproxy', { 'maxconn-server': '500', hsts: 'true', 'buffer-size': '16kB' }, [])
  assert.equal(h2['haproxy-ingress.github.io/maxconn-server'], '500')
  assert.equal(h2['haproxy-ingress.github.io/hsts'], 'true')
  assert.ok(!('haproxy-ingress.github.io/buffer-size' in h2), 'buffer-size 不是有效注解键,注册表已删除该字段,adv 残值应被忽略')
  const tf = buildIngressAnnotations('traefik', { 'router.entrypoints': 'web' }, [])
  assert.equal(tf['traefik.ingress.kubernetes.io/router.entrypoints'], 'web')
  const k = buildIngressAnnotations('kong', { 'strip-path': 'true' }, [])
  assert.equal(k['konghq.com/strip-path'], 'true')
})

test('buildIngressAnnotations: generic 忽略 adv 只拼 custom;未知 dialect 同 generic', () => {
  const g = buildIngressAnnotations('generic', { anything: 'x' }, [{ key: 'a/b', value: '1' }])
  assert.deepEqual(g, { 'a/b': '1' })
  const u = buildIngressAnnotations('no-such', { anything: 'x' }, [])
  assert.deepEqual(u, {})
})

test('方言注册表: PERF_GROUPS 别名=nginx 组;traefik/kong 带 hint,nginx/haproxy 无', () => {
  assert.equal(PERF_GROUPS, INGRESS_DIALECTS.nginx.groups)
  assert.ok(INGRESS_DIALECTS.traefik.hintKey && INGRESS_DIALECTS.kong.hintKey && INGRESS_DIALECTS.generic.hintKey)
  assert.ok(!INGRESS_DIALECTS.nginx.hintKey && !INGRESS_DIALECTS.haproxy.hintKey)
  assert.ok(dialectGroups('traefik').length >= 1 && dialectGroups('generic').length === 0)
  assert.ok(dialectHint('nginx') === '' && dialectHint('traefik') !== '')
})

// --- 端口选择：聚合工作负载 containerPort（去重升序，过滤空值）---
// 契约：stores/cluster.js 的 nsContainerPorts 复用本纯函数；镜像输入结构为 mapWorkload 产物（含 raw）。
import { extractContainerPorts } from '../src/composables/usePorts.js'
test('端口聚合 extractContainerPorts：多工作负载/多容器/多端口去重升序、过滤空值与缺省', () => {
  const workloads = [
    { raw: { spec: { template: { spec: { containers: [
      { name: 'a', ports: [{ containerPort: 8080 }, { containerPort: 3000 }] },
      { name: 'b', ports: [{ containerPort: 8080 }] },                 // 重复 8080
    ] } } } } },
    { raw: { spec: { template: { spec: { containers: [
      { name: 'c', ports: [{ containerPort: 9090 }, { containerPort: '' }, { containerPort: null }] }, // 空值过滤
    ] } } } } },
    { raw: { spec: { template: { spec: { containers: [] } } } } },     // 无端口
    { raw: {} },                                                        // 无 spec
    {},                                                                 // 无 raw
  ]
  assert.deepEqual(extractContainerPorts(workloads), [3000, 8080, 9090])
  assert.deepEqual(extractContainerPorts([]), [])
  assert.deepEqual(extractContainerPorts(undefined), [])
})

// --- Ingress 规则 PATCH body 构造：按 host 聚合 + defaultBackend 启用/删除语义 ---
// 契约：stores/cluster.js 的 updateIngressRules 复用本纯函数；defaultBackend===null 时 merge-patch 删除字段。
import { buildIngressRulesPatch } from '../src/composables/useIngressRules.js'
test('Ingress 规则 PATCH 构造：按 host 聚合 + defaultBackend 启用/删除', () => {
  const flat = [
    { host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 'web', servicePort: '80' },
    { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'api', servicePort: '8080' },
    { host: '', path: '/', pathType: 'Prefix', serviceName: 'default', servicePort: '80' },
  ]
  // 未启用 defaultBackend → null（删除语义）
  const r = buildIngressRulesPatch(flat, null)
  assert.equal(r.spec.rules.length, 2, 'a.com 与空 host 各一组')
  const acom = r.spec.rules.find(x => x.host === 'a.com')
  assert.equal(acom.http.paths.length, 2, 'a.com 下两条 path')
  assert.equal(acom.http.paths[0].backend.service.name, 'web')
  assert.equal(acom.http.paths[1].backend.service.port.number, 8080)
  assert.equal(r.spec.defaultBackend, null, '未启用 → null')
  // 启用 defaultBackend → 对象
  const r2 = buildIngressRulesPatch(flat, { enabled: true, serviceName: 'fallback', servicePort: '80' })
  assert.equal(r2.spec.defaultBackend.service.name, 'fallback')
  assert.equal(r2.spec.defaultBackend.service.port.number, 80)
  // enabled 但缺 serviceName → 视为删除（null）
  const r3 = buildIngressRulesPatch(flat, { enabled: true, serviceName: '', servicePort: '' })
  assert.equal(r3.spec.defaultBackend, null, 'enabled 但无 serviceName → null')
  // 空入参
  assert.deepEqual(buildIngressRulesPatch([], null), { spec: { rules: [], defaultBackend: null } })
  // 默认值：空 path→'/'，空 pathType→'Prefix'；空 port 无数字兜底——端口按类型分流
  // (纯数字→number,否则→name;命名端口不再被 ||80 改写,空值由各入口校验拦截)
  const r4 = buildIngressRulesPatch([{ host: 'x', path: '', pathType: '', serviceName: 's', servicePort: '' }], null)
  assert.equal(r4.spec.rules[0].http.paths[0].path, '/')
  assert.equal(r4.spec.rules[0].http.paths[0].pathType, 'Prefix')
  assert.deepEqual(r4.spec.rules[0].http.paths[0].backend.service.port, { name: '' })
})

// --- Node 丰富信息抽取：容器运行时短名、Taint 归一化、额外字段 ---
test('shortenRuntime 去掉容器运行时 scheme 前缀', () => {
  assert.equal(shortenRuntime('containerd://1.6.18'), '1.6.18')
  assert.equal(shortenRuntime('docker://24.0.7'), '24.0.7')
  assert.equal(shortenRuntime('cri-o://1.28.1'), '1.28.1')
  assert.equal(shortenRuntime(null), null)
  assert.equal(shortenRuntime('1.6.18'), '1.6.18') // 无前缀原样返回
})

test('normalizeTaints 归一化为 {key,value,effect}，缺 value 视为空串', () => {
  assert.deepEqual(normalizeTaints(undefined), [])
  assert.deepEqual(normalizeTaints([{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }]),
    [{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }])
  assert.deepEqual(normalizeTaints([{ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' }]),
    [{ key: 'node.kubernetes.io/unreachable', value: '', effect: 'NoExecute' }])
})

test('extractNodeExtra 抽取 mapNode 未覆盖字段', () => {
  const item = {
    status: {
      nodeInfo: { containerRuntimeVersion: 'containerd://1.6.18', architecture: 'amd64', operatingSystem: 'linux' },
      addresses: [{ type: 'InternalIP', address: '10.0.1.10' }, { type: 'ExternalIP', address: '1.2.3.4' }],
      capacity: { pods: '110' },
      allocatable: { pods: '110' },
    },
    spec: { podCIDR: '10.42.0.0/24', taints: [{ key: 'k', effect: 'NoSchedule' }] },
  }
  const e = extractNodeExtra(item)
  assert.equal(e.externalIp, '1.2.3.4')
  assert.equal(e.containerRuntime, 'containerd://1.6.18')
  assert.equal(e.containerRuntimeShort, '1.6.18')
  assert.equal(e.arch, 'amd64')
  assert.equal(e.osType, 'linux')
  assert.equal(e.taintCount, 1)
  assert.equal(e.podCapacity, 110)
  assert.equal(e.podAllocatable, 110)
  assert.equal(e.podCIDR, '10.42.0.0/24')
})

test('extractNodeExtra 对空对象全部降级为 null/[]', () => {
  const e = extractNodeExtra({})
  assert.equal(e.externalIp, null)
  assert.equal(e.containerRuntime, null)
  assert.equal(e.containerRuntimeShort, null)
  assert.equal(e.arch, null)
  assert.equal(e.osType, null)
  assert.equal(e.taintCount, 0)
  assert.deepEqual(e.taints, [])
  assert.equal(e.podCapacity, null)
  assert.equal(e.podAllocatable, null)
  assert.equal(e.podCIDR, null)
})

// --- PV/StorageClass 编辑 merge-patch 构造（手术式：labels/annotations 删除=null）---
import { diffMap, buildPVPatch, buildStorageClassPatch } from '../src/composables/useStoragePatch.js'
test('diffMap：新增/改值/删除(null)/空', () => {
  assert.deepEqual(diffMap({ a: '1', b: '2' }, { a: '1', b: '9', c: '3' }), { b: '9', c: '3' })
  assert.deepEqual(diffMap({ a: '1' }, {}), { a: null })
  assert.deepEqual(diffMap({ a: '1' }, { a: '1' }), {})
  assert.deepEqual(diffMap({}, { a: '1' }), { a: '1' })
})
test('buildPVPatch：reclaimPolicy + labels/annotations diff；无改动→null', () => {
  const original = { reclaimPolicy: 'Retain', labels: { app: 'x' }, annotations: { note: 'old' } }
  const p1 = buildPVPatch(original, { reclaimPolicy: 'Delete', labels: { app: 'x', tier: 'db' }, annotations: {} })
  assert.equal(p1.spec.persistentVolumeReclaimPolicy, 'Delete')
  assert.deepEqual(p1.metadata.labels, { tier: 'db' })
  assert.deepEqual(p1.metadata.annotations, { note: null })
  // 无改动
  assert.equal(buildPVPatch(original, { reclaimPolicy: 'Retain', labels: { app: 'x' }, annotations: { note: 'old' } }), null)
  // 只传 reclaimPolicy 且不变 → null
  assert.equal(buildPVPatch(original, { reclaimPolicy: 'Retain' }), null)
  // 只删 label
  const p3 = buildPVPatch(original, { labels: {} })
  assert.deepEqual(p3.metadata.labels, { app: null })
  assert.equal(p3.spec, undefined)
})
test('buildStorageClassPatch：default 注解 + labels/annotations（排除 is-default 键）', () => {
  const original = { default: false, labels: { a: '1' }, annotations: { 'storageclass.kubernetes.io/is-default-class': 'false', note: 'x' } }
  // 启用 default + 改普通 annotation
  const p1 = buildStorageClassPatch(original, { isDefault: true, annotations: { note: 'y' } })
  assert.equal(p1.metadata.annotations['storageclass.kubernetes.io/is-default-class'], 'true')
  assert.equal(p1.metadata.annotations.note, 'y')
  // default 不变 + annotations 不变 → null（is-default 不因 desired 缺它而被 null 删除）
  assert.equal(buildStorageClassPatch(original, { isDefault: false, annotations: { note: 'x' } }), null)
  // 只改 label
  const p3 = buildStorageClassPatch(original, { labels: { a: '2' } })
  assert.deepEqual(p3.metadata.labels, { a: '2' })
  // 关闭 default（原本 false → 不变 → null；用 true 原始测关闭）
  const p4 = buildStorageClassPatch({ default: true, labels: {}, annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, { isDefault: false })
  assert.equal(p4.metadata.annotations['storageclass.kubernetes.io/is-default-class'], 'false')
})

// --- 集群健康判定：控制面优先分级（Disconnected/Critical/Degraded/Healthy）---
import { computeClusterHealth } from '../src/composables/useClusterHealth.js'
test('computeClusterHealth：控制面优先分级', () => {
  const cp = st => ({ isControlPlane: true, status: st })
  const w = st => ({ isControlPlane: false, status: st })
  // Healthy：控制面全 Ready + worker 全 Ready
  let h = computeClusterHealth({ nodeList: [cp('Ready'), cp('Ready'), w('Ready')], apiReachable: true })
  assert.equal(h.status, 'Healthy'); assert.equal(h.severity, 'ok')
  assert.equal(h.controlPlane.total, 2); assert.equal(h.controlPlane.ready, 2); assert.equal(h.workers.total, 1)
  // 控制面有 NotReady → Critical
  h = computeClusterHealth({ nodeList: [cp('Ready'), cp('NotReady'), w('Ready')], apiReachable: true })
  assert.equal(h.status, 'Critical'); assert.equal(h.severity, 'crit'); assert.equal(h.controlPlane.ready, 1)
  // worker NotReady（控制面全 Ready）→ Degraded
  h = computeClusterHealth({ nodeList: [cp('Ready'), w('Ready'), w('NotReady')], apiReachable: true })
  assert.equal(h.status, 'Degraded'); assert.equal(h.severity, 'warn'); assert.equal(h.workers.ready, 1)
  // apiReachable=false → Disconnected（即使节点全 Ready）
  assert.equal(computeClusterHealth({ nodeList: [cp('Ready')], apiReachable: false }).status, 'Disconnected')
  // 空 nodeList → Disconnected
  assert.equal(computeClusterHealth({ nodeList: [], apiReachable: true }).status, 'Disconnected')
  // 无控制面（role 标签缺失，isControlPlane 全 false）→ 按 worker 判定 Degraded
  h = computeClusterHealth({ nodeList: [w('Ready'), w('NotReady')], apiReachable: true })
  assert.equal(h.status, 'Degraded'); assert.equal(h.controlPlane.total, 0)
})

// --- 网关故障转移：错误分类（网络错误/5xx→转移；4xx/null→不转移）---
import { isFailoverEligible } from '../server/failover.js'
test('isFailoverEligible：网络错误/5xx/超时→true；4xx/null→false', () => {
  assert.equal(isFailoverEligible({ code: 'ECONNREFUSED' }), true)
  assert.equal(isFailoverEligible({ code: 'ECONNRESET' }), true)
  assert.equal(isFailoverEligible({ code: 'ETIMEDOUT' }), true)
  assert.equal(isFailoverEligible({ code: 'ENOTFOUND' }), true)
  assert.equal(isFailoverEligible({ code: 'UND_ERR_SOCKET' }), true)
  assert.equal(isFailoverEligible({ name: 'AbortError' }), true)
  assert.equal(isFailoverEligible({ message: 'Request timed out' }), true)
  assert.equal(isFailoverEligible({ status: 503 }), true)
  assert.equal(isFailoverEligible({ status: 500 }), true)
  assert.equal(isFailoverEligible({ status: 404 }), false)
  assert.equal(isFailoverEligible({ status: 401 }), false)
  assert.equal(isFailoverEligible({ status: 409 }), false)
  assert.equal(isFailoverEligible(null), false)
  assert.equal(isFailoverEligible(undefined), false)
  assert.equal(isFailoverEligible({ message: 'some 4xx error', status: 403 }), false)
})

// --- Secret 模板：buildSecretData 构造 + detectSecretTemplate 判定 ---
import { SECRET_TEMPLATES, detectSecretTemplate, buildSecretData } from '../src/composables/useSecretTemplates.js'
test('buildSecretData: Docker 模板生成 .dockerconfigjson JSON', () => {
  const data = buildSecretData('docker', { server: 'ghcr.io', username: 'user', password: 'pat123', email: 'a@b.com' })
  assert.ok('.dockerconfigjson' in data, '应有 .dockerconfigjson key')
  const parsed = JSON.parse(data['.dockerconfigjson'])
  assert.ok('auths' in parsed, 'JSON 应含 auths')
  assert.ok('ghcr.io' in parsed.auths, 'auths 应含 ghcr.io')
  assert.equal(parsed.auths['ghcr.io'].username, 'user')
  assert.equal(parsed.auths['ghcr.io'].password, 'pat123')
  assert.ok(parsed.auths['ghcr.io'].auth, '应有 auth base64')
})
test('buildSecretData: TLS 模板 tls.crt + tls.key', () => {
  const data = buildSecretData('tls', { cert: 'CERTPEM', key: 'KEYPEM' })
  assert.deepEqual(data, { 'tls.crt': 'CERTPEM', 'tls.key': 'KEYPEM' })
})
test('buildSecretData: SSH 模板 ssh-privatekey + 可选 known_hosts', () => {
  assert.deepEqual(buildSecretData('ssh', { privatekey: 'SSHKEY' }), { 'ssh-privatekey': 'SSHKEY' })
  assert.deepEqual(buildSecretData('ssh', { privatekey: 'SSHKEY', known_hosts: 'HOSTS' }), { 'ssh-privatekey': 'SSHKEY', known_hosts: 'HOSTS' })
})
test('buildSecretData: basic-auth username+password', () => {
  assert.deepEqual(buildSecretData('basic-auth', { username: 'admin', password: 'pass' }), { username: 'admin', password: 'pass' })
})
test('buildSecretData: git-token GitHub→GITHUB_TOKEN', () => {
  const data = buildSecretData('git-token', { service: 'github', token: 'ghp_xxx' })
  assert.deepEqual(data, { GITHUB_TOKEN: 'ghp_xxx' })
  const data2 = buildSecretData('git-token', { service: 'gitlab', token: 'glpat-xxx' })
  assert.deepEqual(data2, { GITLAB_TOKEN: 'glpat-xxx' })
})
test('buildSecretData: Opaque 直接 key-value', () => {
  assert.deepEqual(buildSecretData('opaque', { data: [{ key: 'K', value: 'V' }] }), { K: 'V' })
})
test('buildSecretData: AWS 凭证 3 keys', () => {
  const data = buildSecretData('aws', { access_key_id: 'AKIA...', secret_access_key: 'SECRET', region: 'us-east-1' })
  assert.deepEqual(data, { AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'SECRET', AWS_REGION: 'us-east-1' })
})
test('detectSecretTemplate: 按 type+keys 判定', () => {
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/dockerconfigjson' }), 'docker')
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/tls', data: { 'tls.crt': '', 'tls.key': '' } }), 'tls')
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/ssh-auth' }), 'ssh')
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/basic-auth' }), 'basic-auth')
  assert.equal(detectSecretTemplate({ type: 'Opaque', data: { GITHUB_TOKEN: '' } }), 'git-token')
  assert.equal(detectSecretTemplate({ type: 'Opaque', data: { AWS_ACCESS_KEY_ID: '' } }), 'aws')
  assert.equal(detectSecretTemplate({ type: 'Opaque', data: { random: '' } }), 'opaque')
})

// --- dumpResourceYaml：原始 K8s 对象 → 干净 YAML（剔除 managedFields，可选 status） ---
test('dumpResourceYaml 剔除 managedFields、默认保留 status', () => {
  const raw = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web', managedFields: [{ x: 1 }] }, status: { phase: 'Running' }, spec: { containers: [] } }
  const y = dumpResourceYaml(raw)
  assert.ok(!y.includes('managedFields'), 'managedFields 应被剔除')
  assert.ok(y.includes('phase: Running'), 'status 默认保留')
  assert.ok(y.includes('kind: Pod'))
})
test('dumpResourceYaml stripStatus=true 剔除 status', () => {
  const raw = { kind: 'Service', metadata: { name: 's', managedFields: [{}] }, status: { loadBalancer: { ingress: [] } }, spec: {} }
  const y = dumpResourceYaml(raw, { stripStatus: true })
  assert.ok(!y.includes('loadBalancer'), 'status 应被剔除')
})
test('dumpResourceYaml 空/undefined 安全返回空串', () => {
  assert.equal(dumpResourceYaml(null), '')
  assert.equal(dumpResourceYaml(undefined), '')
})
test('dumpResourceYaml 不修改原对象', () => {
  const raw = { metadata: { name: 'n', managedFields: [1] }, status: { x: 1 } }
  dumpResourceYaml(raw)
  assert.ok(Array.isArray(raw.metadata.managedFields), '原对象 managedFields 不被破坏')
  assert.ok(raw.status, '原对象 status 不被破坏')
})
test('dumpResourceYaml 缺 metadata 的对象不报错', () => {
  const y = dumpResourceYaml({ apiVersion: 'v1', kind: 'Service', spec: { type: 'ClusterIP' } })
  assert.ok(y.includes('kind: Service'))
  assert.ok(!y.includes('managedFields'))
})

// --- 复制 workload:K8s 对象 → 向导表单(反向映射,best-effort)---
test('workloadToForm: 完整 Deployment 映射主容器/副本/标签/节点选择/容忍', () => {
  const obj = {
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'prod', labels: { app: 'api', 'pod-template-hash': 'abc' }, annotations: { note: 'x' } },
    spec: { replicas: 3, template: { spec: { nodeSelector: { disk: 'ssd' }, tolerations: [{ key: 'k', value: 'v', effect: 'NoSchedule' }], containers: [{ name: 'api', image: 'nginx:1.25', imagePullPolicy: 'Always', command: ['sh', '-c'], args: ['sleep 1'], workingDir: '/app', ports: [{ containerPort: 8080, protocol: 'TCP' }], env: [{ name: 'FOO', value: 'bar' }, { name: 'REF', valueFrom: { configMapKeyRef: { name: 'cm' } } }], resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } }, livenessProbe: { httpGet: { path: '/health', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 }, volumeMounts: [{ name: 'data', mountPath: '/data' }] }] } } },
  }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.workloadType, 'Deployment')
  assert.equal(f.name, 'api')
  assert.equal(f.namespace, 'prod')
  assert.equal(f.replicas, 3)
  assert.deepEqual(f.labels, [{ key: 'app', value: 'api' }])              // pod-template-hash 被剔除
  assert.deepEqual(f.annotations, [{ key: 'note', value: 'x' }])
  assert.equal(f.image, 'nginx:1.25')
  assert.equal(f.containerName, 'api')
  assert.equal(f.pullPolicy, 'Always')
  assert.equal(f.command, 'sh -c')
  assert.equal(f.args, 'sleep 1')
  assert.equal(f.workingDir, '/app')
  assert.deepEqual(f.ports, [{ containerPort: '8080', protocol: 'TCP' }])
  assert.deepEqual(f.envVars, [{ key: 'FOO', value: 'bar' }])             // valueFrom 类不映射
  assert.equal(f.cpuRequest, '250m'); assert.equal(f.cpuLimit, '500m')
  assert.equal(f.memoryRequest, '256Mi'); assert.equal(f.memoryLimit, '512Mi')
  assert.equal(f.liveness.enabled, true); assert.equal(f.liveness.type, 'http')
  assert.equal(f.liveness.httpPath, '/health'); assert.equal(f.liveness.port, 8080)
  assert.equal(f.liveness.initialDelaySeconds, 5)
  assert.deepEqual(f.nodeSelectors, [{ key: 'disk', value: 'ssd' }])
  assert.deepEqual(f.tolerations, [{ key: 'k', operator: 'Equal', value: 'v', effect: 'NoSchedule' }])
  assert.equal(f.volumeMounts.length, 1); assert.equal(f.volumeMounts[0].name, 'data')
  assert.equal(f.extraContainers.length, 0); assert.equal(f.initContainers.length, 0)
})

test('workloadToForm: 多容器 —— 主容器完整,其余进 extraContainers,init 进 initContainers', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'm', namespace: 'd' }, spec: { template: { spec: { containers: [{ name: 'main', image: 'a' }, { name: 'side', image: 'b' }], initContainers: [{ name: 'init', image: 'c' }] } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.containerName, 'main'); assert.equal(f.image, 'a')
  assert.equal(f.extraContainers.length, 1); assert.equal(f.extraContainers[0].name, 'side'); assert.equal(f.extraContainers[0].image, 'b')
  assert.equal(f.initContainers.length, 1); assert.equal(f.initContainers[0].name, 'init')
})

test('workloadToForm: CronJob 取嵌套 podSpec + schedule;Job 取 completions/parallelism', () => {
  const cron = { kind: 'CronJob', metadata: { name: 'c', namespace: 'n' }, spec: { schedule: '*/10 * * * *', concurrencyPolicy: 'Forbid', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'c', image: 'img' }] } } } } } }
  const fc = workloadToForm(cron, 'CronJob')
  assert.equal(fc.image, 'img')                                  // 嵌套路径取到容器
  assert.equal(fc.cronConfig.schedule, '*/10 * * * *')
  assert.equal(fc.cronConfig.concurrencyPolicy, 'Forbid')
  const job = { kind: 'Job', metadata: { name: 'j', namespace: 'n' }, spec: { completions: 2, parallelism: 4, backoffLimit: 3, template: { spec: { containers: [{ name: 'j', image: 'i' }] } } } }
  const fj = workloadToForm(job, 'Job')
  assert.equal(fj.jobConfig.completions, 2); assert.equal(fj.jobConfig.parallelism, 4); assert.equal(fj.jobConfig.backoffLimit, 3)
})

test('workloadToForm: 缺字段容错 + 未知 kind 返回 null', () => {
  const f = workloadToForm({ metadata: { name: 'x' }, spec: { template: { spec: {} } } }, 'Deployment')
  assert.equal(f.name, 'x'); assert.equal(f.replicas, 1); assert.equal(f.image, ''); assert.deepEqual(f.ports, [])
  assert.equal(workloadToForm(null, 'Deployment'), null)
  assert.equal(workloadToForm({ kind: 'Pod' }, 'Deployment') && true, true) // 不崩即可
})

test('workloadToForm: tcp/exec 探针映射 + readiness/startup 默认关闭', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'p', namespace: 'n' }, spec: { template: { spec: { containers: [{ name: 'p', image: 'i', readinessProbe: { tcpSocket: { port: 9090 } } }] } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.readiness.enabled, true); assert.equal(f.readiness.type, 'tcp'); assert.equal(f.readiness.port, 9090)
  assert.equal(f.liveness.enabled, false); assert.equal(f.startup.enabled, false)
})

test('workloadToForm: NFS volume 映射 type/server/nfsPath', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'n', namespace: 'd' }, spec: { template: { spec: { volumes: [{ name: 'data', nfs: { server: '10.0.0.1', path: '/export' } }], containers: [{ name: 'c', image: 'i', volumeMounts: [{ name: 'data', mountPath: '/data' }] }] } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.volumeMounts.length, 1)
  assert.equal(f.volumeMounts[0].type, 'nfs')
  assert.equal(f.volumeMounts[0].server, '10.0.0.1')
  assert.equal(f.volumeMounts[0].nfsPath, '/export')
})

test('workloadToForm: toleration 带 operator Equal + value 原样保留', () => {
  const obj = { kind: 'Deployment', metadata: { name: 't', namespace: 'n' }, spec: { template: { spec: { tolerations: [{ key: 'k', operator: 'Equal', value: 'v', effect: 'NoSchedule' }] } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.deepEqual(f.tolerations, [{ key: 'k', operator: 'Equal', value: 'v', effect: 'NoSchedule' }])
})
test('workloadToForm: toleration 缺 operator 时按 value 推断(Equal/Exists)', () => {
  const withVal = { kind: 'Deployment', metadata: { name: 'a', namespace: 'n' }, spec: { template: { spec: { tolerations: [{ key: 'k', value: 'v', effect: 'NoSchedule' }] } } } }
  assert.equal(workloadToForm(withVal, 'Deployment').tolerations[0].operator, 'Equal')
  const noVal = { kind: 'Deployment', metadata: { name: 'b', namespace: 'n' }, spec: { template: { spec: { tolerations: [{ key: 'k', effect: 'NoSchedule' }] } } } }
  assert.equal(workloadToForm(noVal, 'Deployment').tolerations[0].operator, 'Exists')
})

// 系统管理注解剔除(2026-08-16 线上事故):复制 workload 把 deployment.kubernetes.io/revision:"14"
// 带进新负载表单 → 向导 YAML 裸拼成数字 14 → apiserver SSA 拒绝(expected string)。
// revision/restartedAt/last-applied 等是控制器/平台管理的字段,不属于用户意图,复制时必须丢弃。
test('workloadToForm: 系统管理注解(revision/restartedAt/last-applied/平台痕迹)不带入表单,用户注解保留', () => {
  const obj = {
    kind: 'Deployment',
    metadata: {
      name: 'api', namespace: 'prod',
      labels: { app: 'api', 'pod-template-hash': 'abc' },
      annotations: {
        'deployment.kubernetes.io/revision': '14',
        'kubectl.kubernetes.io/restartedAt': '2026-08-16T09:00:00Z',
        'kubectl.kubernetes.io/last-applied-configuration': '{"kind":"Deployment"}',
        'aliangboard.io/last-edited': '2026-08-15',
        'aliangboard.io/last-action': 'scale',
        note: 'keep-me',
      },
    },
    spec: { template: { spec: { containers: [{ name: 'api', image: 'nginx' }] } } },
  }
  const f = workloadToForm(obj, 'Deployment')
  assert.deepEqual(f.annotations, [{ key: 'note', value: 'keep-me' }])
})

// --- command/args 切分约定(command=空白切分 shell token;args=每行一条,含空格不拆散) ---
test('containerTokens: splitCommandTokens 空白切分去空项;splitArgLines 每行一条', () => {
  assert.deepEqual(splitCommandTokens('  sh   -c '), ['sh', '-c'])
  assert.deepEqual(splitCommandTokens(''), [])
  assert.deepEqual(splitArgLines('cp /data/config.yaml /initconfig/config.yaml'), ['cp /data/config.yaml /initconfig/config.yaml'])
  assert.deepEqual(splitArgLines('--port=8080\n--debug\n\n  \n-x'), ['--port=8080', '--debug', '-x'])
  assert.deepEqual(splitArgLines(''), [])
})

test('containerTokens: splitCommandTokens 引号感知(单/双引号内空格不切,\\\" 转义);joinCommandTokens 反向补引号往返', () => {
  assert.deepEqual(splitCommandTokens('sh -c "echo hi"'), ['sh', '-c', 'echo hi'])
  assert.deepEqual(splitCommandTokens("sh -c 'echo hi'"), ['sh', '-c', 'echo hi'])
  assert.deepEqual(splitCommandTokens('--flag="a b"'), ['--flag=a b'])
  assert.deepEqual(splitCommandTokens('"say \\"hi\\""'), ['say "hi"'])
  assert.equal(joinCommandTokens(['sh', '-c', 'echo hi']), 'sh -c "echo hi"')       // 含空格 token 重引号
  assert.deepEqual(splitCommandTokens(joinCommandTokens(['sh', '-c', 'echo hi'])), ['sh', '-c', 'echo hi'])  // 往返无损
  assert.equal(joinCommandTokens(['sh', '-c']), 'sh -c')                             // 无空格 token 不加引号
})

test('workloadToForm: args 按行映射 —— 单条含空格整行保留,多条换行分隔(command 仍空格 join)', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'a', namespace: 'n' }, spec: { template: { spec: {
    containers: [{ name: 'main', image: 'img', command: ['sh', '-c'], args: ['cp /a /b'] }],
    initContainers: [{ name: 'init', image: 'i', command: ['sh', '-c'], args: ['cp /a /b', '-x'] }],
  } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.command, 'sh -c')
  assert.equal(f.args, 'cp /a /b')                       // 单条 → 单行,空格保留
  assert.equal(f.initContainers[0].args, 'cp /a /b\n-x') // 多条 → 每行一条
  assert.equal(f.initContainers[0].command, 'sh -c')
})

test('workloadToForm: sidecar 不再丢 args(按行映射)', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'a', namespace: 'n' }, spec: { template: { spec: {
    containers: [{ name: 'main', image: 'img' }, { name: 'side', image: 'envoy', command: ['envoy'], args: ['-c', '/etc/envoy.yaml'] }],
  } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.extraContainers[0].args, '-c\n/etc/envoy.yaml')
  assert.equal(f.extraContainers[0].command, 'envoy')
})

test('command/args 往返:K8s 数组 → workloadToForm → 切分工具 → 还原数组(无损)', () => {
  const src = { kind: 'Deployment', metadata: { name: 'a', namespace: 'n' }, spec: { template: { spec: {
    containers: [{ name: 'main', image: 'img', command: ['sh', '-c'], args: ['cp /data/config.yaml /initconfig/config.yaml', '--flag=1'] }],
    initContainers: [{ name: 'init', image: 'i', command: ['sh', '-c'], args: ['cp /a /b'] }],
  } } } }
  const f = workloadToForm(src, 'Deployment')
  assert.deepEqual(splitCommandTokens(f.command), ['sh', '-c'])
  assert.deepEqual(splitArgLines(f.args), ['cp /data/config.yaml /initconfig/config.yaml', '--flag=1'])
  assert.deepEqual(splitCommandTokens(f.initContainers[0].command), ['sh', '-c'])
  assert.deepEqual(splitArgLines(f.initContainers[0].args), ['cp /a /b'])
})

// --- StorageClass 预设目录完整性 ---
test('StorageClass 预设恰好 16 个,4 family 全覆盖', () => {
  assert.equal(STORAGE_CLASS_PRESETS.length, 16)
  const families = new Set(STORAGE_CLASS_PRESETS.map(p => p.family))
  for (const f of ['local', 'distributed', 'nfs', 'cloud']) assert.ok(families.has(f), `missing family ${f}`)
})

test('每个 StorageClass 预设字段完整且 requiredParams ⊆ parameters', () => {
  const validBinding = new Set(['Immediate', 'WaitForFirstConsumer'])
  const ids = new Set()
  for (const p of STORAGE_CLASS_PRESETS) {
    assert.ok(p.id, `preset missing id: ${JSON.stringify(p)}`)
    assert.ok(!ids.has(p.id), `dup preset id: ${p.id}`); ids.add(p.id)
    assert.ok(p.provisioner, `preset ${p.id} missing provisioner`)
    assert.ok(validBinding.has(p.volumeBindingMode), `preset ${p.id} bad volumeBindingMode ${p.volumeBindingMode}`)
    assert.ok(typeof p.allowVolumeExpansion === 'boolean', `preset ${p.id} allowVolumeExpansion not bool`)
    for (const rk of (p.requiredParams || [])) {
      assert.ok((p.parameters || {}).hasOwnProperty(rk), `preset ${p.id} requiredParams "${rk}" 不在 parameters 中`)
    }
  }
})

test('STORAGE_CLASS_PRESET_FAMILIES 4 项且 labelKey 与预设 family 对应', () => {
  assert.deepEqual(STORAGE_CLASS_PRESET_FAMILIES.map(f => f.key), ['local', 'distributed', 'nfs', 'cloud'])
})

// --- 参数纯函数 ---
test('paramsMapToRows / paramsRowsToMap 无损往返(保序、空键跳过)', () => {
  const rows = paramsMapToRows({ server: '10.0.0.1', share: '/data', type: 'nfs' })
  assert.deepEqual(rows, [
    { key: 'server', value: '10.0.0.1' },
    { key: 'share', value: '/data' },
    { key: 'type', value: 'nfs' },
  ])
  assert.deepEqual(paramsRowsToMap(rows), { server: '10.0.0.1', share: '/data', type: 'nfs' })
  assert.deepEqual(paramsRowsToMap([{ key: '  ', value: 'x' }, { key: 'k', value: 'v' }]), { k: 'v' })
})

test('normalizeParamsToMap 接受 rows / map / 逗号串三态', () => {
  assert.deepEqual(normalizeParamsToMap([{ key: 'a', value: '1' }]), { a: '1' })
  assert.deepEqual(normalizeParamsToMap({ a: '1', b: '2' }), { a: '1', b: '2' })
  assert.deepEqual(normalizeParamsToMap('a=1,b=2'), { a: '1', b: '2' })
  // 值含 '=' 时按首个 '=' 切分,其余属值
  assert.deepEqual(normalizeParamsToMap('conn=a=b'), { conn: 'a=b' })
  assert.deepEqual(normalizeParamsToMap(null), {})
  assert.deepEqual(normalizeParamsToMap(''), {})
})

test('hasPlaceholderParam 命中 <...> 占位符', () => {
  const rows = paramsMapToRows({ server: '<IP>', share: '/real' })
  assert.equal(hasPlaceholderParam(rows, ['server']), true)
  assert.equal(hasPlaceholderParam(rows, ['share']), false)
  assert.equal(hasPlaceholderParam(rows, []), false)
})

test('presetToFormState 把预设铺成表单状态(parameters 转 KV 行)', () => {
  const nfs = STORAGE_CLASS_PRESETS.find(p => p.id === 'nfs-csi')
  const form = presetToFormState(nfs)
  assert.equal(form.provisioner, 'nfs.csi.k8s.io')
  assert.equal(form.volumeBindingMode, 'Immediate')
  assert.equal(form.allowVolumeExpansion, true)
  assert.equal(form.default, false)
  assert.ok(Array.isArray(form.parameters) && form.parameters.length === 3)
})

// --- StorageClass YAML 构造 ---
test('buildStorageClassYaml: 基本字段 + volumeBindingMode + 占位符原样保留(nfs-csi)', () => {
  const yaml = buildStorageClassYaml({
    name: 'nfs-client', provisioner: 'nfs.csi.k8s.io', reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate', allowVolumeExpansion: true,
    parameters: [{ key: 'server', value: '<IP>' }, { key: 'share', value: '/data' }, { key: 'csi.storage.k8s.io/fstype', value: 'nfs' }],
  })
  const lines = yaml.split('\n')
  assert.equal(lines[0], 'apiVersion: storage.k8s.io/v1')
  assert.equal(lines[1], 'kind: StorageClass')
  assert.ok(lines.includes('metadata:'))
  assert.ok(lines.includes('  name: nfs-client'))
  assert.ok(lines.includes('provisioner: nfs.csi.k8s.io'))
  assert.ok(lines.includes('reclaimPolicy: Delete'))
  assert.ok(lines.includes('volumeBindingMode: Immediate'))
  assert.ok(lines.includes('allowVolumeExpansion: true'))
  assert.ok(lines.includes('parameters:'))
  assert.ok(lines.includes('    server: <IP>'), '占位符必须原样保留')
  assert.ok(lines.includes('    share: /data'))
})

test('buildStorageClassYaml: 多参数(Ceph RBD 11 项)全输出', () => {
  const yaml = buildStorageClassYaml({
    name: 'rook-ceph-block', provisioner: 'rook-ceph.rbd.csi.ceph.com', reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate', allowVolumeExpansion: true,
    parameters: { clusterID: 'rook-ceph', pool: 'replicapool', imageFormat: '2', imageFeatures: 'layering' },
  })
  for (const frag of ['    clusterID: rook-ceph', '    pool: replicapool', '    imageFormat: 2', '    imageFeatures: layering']) {
    assert.ok(yaml.includes(frag), `missing param line: ${frag}`)
  }
})

test('buildStorageClassYaml: allowVolumeExpansion=false 不输出该行;空参数输出 {}', () => {
  const yaml = buildStorageClassYaml({
    name: 'local-path', provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete',
    volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: false, parameters: [],
  })
  assert.ok(!yaml.includes('allowVolumeExpansion'), 'false 时不应输出 allowVolumeExpansion')
  assert.ok(yaml.includes('parameters:\n    {}'), '空参数应输出 {}')
})

test('buildStorageClassYaml: 旧逗号串参数仍兼容(normalizeParamsToMap)', () => {
  const yaml = buildStorageClassYaml({
    name: 'sc', provisioner: 'ebs.csi.aws.com', parameters: 'type=gp3',
  })
  assert.ok(yaml.includes('volumeBindingMode: WaitForFirstConsumer'), '缺省 binding=WaitForFirstConsumer')
  assert.ok(yaml.includes('    type: gp3'))
  assert.ok(yaml.includes('provisioner: kubernetes.io/no-provisioner') === false)
})

test('buildStorageClassYaml: mountOptions 仅在非空数组时输出', () => {
  const withMount = buildStorageClassYaml({ name: 'nfs', provisioner: 'nfs.csi.k8s.io', mountOptions: ['hard', 'nfsvers=4.1'], parameters: [] })
  assert.ok(withMount.includes('mountOptions:'))
  assert.ok(withMount.includes('  - hard'))
  assert.ok(withMount.includes('  - nfsvers=4.1'))
  const noMount = buildStorageClassYaml({ name: 'x', provisioner: 'p', parameters: [] })
  assert.ok(!noMount.includes('mountOptions:'))
})

test('buildStorageClassYaml: default=true 输出 is-default-class 注解;false/缺省不输出', () => {
  const yamlTrue = buildStorageClassYaml({ name: 'x', provisioner: 'p', default: true, parameters: [] })
  assert.ok(yamlTrue.includes('annotations:'), 'default=true 时应输出 annotations 块')
  assert.ok(yamlTrue.includes('storageclass.kubernetes.io/is-default-class: "true"'), '应含 is-default-class 注解')
  const yamlFalse = buildStorageClassYaml({ name: 'x', provisioner: 'p', default: false, parameters: [] })
  assert.ok(!yamlFalse.includes('annotations:'), 'default=false 时不应输出 annotations')
  assert.ok(!yamlFalse.includes('is-default-class'), 'default=false 时不应含 is-default-class')
  const yamlUnset = buildStorageClassYaml({ name: 'x', provisioner: 'p', parameters: [] })
  assert.ok(!yamlUnset.includes('annotations:'), '缺省 default 时不应输出 annotations')
})

// --- NetworkPolicy 创建向导:默认模型 / 后果 / denyAll ---
test('defaultModel 放行起步:每方向一条未限定源规则 → allowAll', () => {
  const m = defaultModel('default')
  assert.equal(m.kind, 'NetworkPolicy')
  assert.equal(m.apiVersion, 'networking.k8s.io/v1')
  assert.equal(m.metadata.namespace, 'default')
  assert.deepEqual(m.spec.policyTypes.sort(), ['Egress', 'Ingress'])
  assert.equal(m.spec.ingress.length, 1)
  assert.equal(m.spec.egress.length, 1)
  assert.deepEqual(m.spec.ingress[0], { from: [], ports: [] })
  assert.equal(consequence(m.spec, 'ingress').state, 'allowAll')
  assert.equal(consequence(m.spec, 'egress').state, 'allowAll')
  assert.equal(isDenyAll(m.spec), false)
})

test('consequence:四态判定', () => {
  // none:policyTypes 不含该方向
  const none = { policyTypes: ['Egress'], ingress: [], egress: [{ to: [{ podSelector: { matchLabels: {} } }], ports: [] }] }
  assert.equal(consequence(none, 'ingress').state, 'none')
  // denyAll:受管方向但无规则
  const deny = { policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [{ to: [], ports: [] }] }
  assert.equal(consequence(deny, 'ingress').state, 'denyAll')
  assert.equal(isDenyAll(deny), true)
  // allowAll:存在「无 peer」的规则(from/to 为空)
  const allow = { policyTypes: ['Ingress'], ingress: [{ from: [], ports: [] }], egress: [] }
  assert.equal(consequence(allow, 'ingress').state, 'allowAll')
  // scoped:所有规则都有具体 peer
  const scoped = { policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: { matchLabels: { app: 'x' } } }], ports: [{ protocol: 'TCP', port: 80 }] }], egress: [] }
  const c = consequence(scoped, 'ingress')
  assert.equal(c.state, 'scoped')
  assert.equal(c.peers, 1)
  assert.equal(c.ports, 1)
  assert.equal(isDenyAll(scoped), false)
})

test('工厂函数形状稳定', () => {
  assert.deepEqual(emptySelector(), { matchLabels: {}, matchExpressions: [] })
  assert.deepEqual(emptyPort(), { protocol: 'TCP', port: '' })
  assert.deepEqual(emptyIngressRule(), { from: [], ports: [] })
  assert.deepEqual(emptyEgressRule(), { to: [], ports: [] })
  assert.deepEqual(emptyPeer(), { podSelector: { matchLabels: {}, matchExpressions: [] } })
})

test('modelToYaml/parseAndValidate 语义往返深相等(含进阶特性)', () => {
  const model = {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'p1', namespace: 'default' },
    spec: {
      podSelector: { matchLabels: { app: 'web' }, matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'staging'] }] },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [
          { podSelector: { matchLabels: { role: 'api' } }, namespaceSelector: { matchLabels: { tier: 'be' } } },
          { ipBlock: { cidr: '10.0.0.0/8', except: ['10.0.1.0/24'] } },
        ],
        ports: [{ protocol: 'TCP', port: 80, endPort: 90 }, { protocol: 'TCP', port: 'https' }],
      }],
      egress: [],
    },
  }
  const yaml = modelToYaml(model)
  const res = parseAndValidate(yaml)
  assert.ok(res.ok, '合法 YAML 应解析成功')
  assert.deepEqual(res.model, model)
})

test('parseAndValidate 错误码', () => {
  assert.equal(parseAndValidate('apiVersion: v1\nkind: Pod\nmetadata: {name: x}').code, 'notNetworkPolicy')
  assert.equal(parseAndValidate('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {}\nspec: {}').code, 'nameRequired')
  assert.equal(parseAndValidate(':::not yaml:::').code, 'parseError')
})
// --- 自定义列核心:迁移 v1→v2 ---
test('migrateV1toV2: false 标记转 hidden,其它丢弃', () => {
  const v1 = { nodes: { system: false, pods: false, name: true }, workloads: { namespace: false } }
  const v2 = migrateV1toV2(v1)
  assert.deepStrictEqual(v2, {
    nodes: { hidden: { system: true, pods: true } },     // name:true 非 false → 不计入
    workloads: { hidden: { namespace: true } },
  })
})
test('migrateV1toV2: 非对象/空 → {}', () => {
  assert.deepStrictEqual(migrateV1toV2(null), {})
  assert.deepStrictEqual(migrateV1toV2({}), {})
  assert.deepStrictEqual(migrateV1toV2('x'), {})
})
test('migrateV1toV2: 全显示的表不产出空 hidden', () => {
  assert.deepStrictEqual(migrateV1toV2({ nodes: { name: true } }), {})
})

// --- 自定义列核心:reconcile 对账 ---
const CAT = [
  { key: 'a', labelKey: 'x.a', label: 'A' },
  { key: 'b', labelKey: 'x.b', label: 'B' },
  { key: 'c', labelKey: 'x.c', label: 'C' },
]
test('reconcile: 无 overrides → 默认序全可见', () => {
  const r = reconcileColumns(CAT)
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['a', 'b', 'c'])
  assert.deepStrictEqual(r.visible.map(x => x.key), ['a', 'b', 'c'])
  assert.equal(r.ordered[0].hidden, false)
})
test('reconcile: order 重排,未列入的按默认序追加到末尾', () => {
  const r = reconcileColumns(CAT, { order: ['c', 'a'] })  // b 未列入
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['c', 'a', 'b'])
})
test('reconcile: order 含已删除的 key 被忽略,不报错', () => {
  const r = reconcileColumns(CAT, { order: ['b', 'ghost', 'a'] })
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['b', 'a', 'c'])
})
test('reconcile: hidden 过滤 visible,ordered 仍含全部并带标记', () => {
  const r = reconcileColumns(CAT, { hidden: { b: true } })
  assert.deepStrictEqual(r.visible.map(x => x.key), ['a', 'c'])
  assert.equal(r.ordered.find(x => x.key === 'b').hidden, true)
  assert.equal(r.ordered.find(x => x.key === 'a').hidden, false)
})
test('reconcile: width 合并到列上', () => {
  const r = reconcileColumns(CAT, { width: { a: 200 } })
  assert.equal(r.ordered.find(x => x.key === 'a').width, 200)
  assert.equal(r.ordered.find(x => x.key === 'b').width, undefined)
})
test('reconcile: catalog 新增列自动出现在末尾(老配置前向兼容)', () => {
  const r = reconcileColumns(CAT, { order: ['a', 'b'], hidden: { a: true } })
  // 新列 c 不在老 order → 末尾;且默认可见
  assert.deepStrictEqual(r.visible.map(x => x.key), ['b', 'c'])
})
test('reconcile: 容错非法 overrides', () => {
  const r = reconcileColumns(CAT, { order: 'nope', hidden: null, width: 3 })
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['a', 'b', 'c'])
})

test('STORAGE_KEY 为 v2', () => {
  assert.equal(STORAGE_KEY, 'aliangboard.tableColumns.v2')
  assert.equal(STORAGE_KEY_V1, 'aliangboard.tableColumns.v1')
})

// --- PVC 用量:字节数格式化 ---
test('formatBytes: 边界与二进制单位', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(2048), '2 Ki')
  assert.equal(formatBytes(3221225472), '3 Gi')           // 3 GiB,无小数
  assert.equal(formatBytes(5368709120), '5 Gi')           // 5 GiB,无小数
  assert.equal(formatBytes(2621440), '2.5 Mi')            // 2.5 MiB,带小数
  assert.equal(formatBytes(10737418240), '10 Gi')          // 10 GiB
  assert.equal(formatBytes(1649267441664), '1.5 Ti')       // 1.5 TiB
})

test('formatBytes: 非法/空值 → 占位', () => {
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatBytes(NaN), '—')
  assert.equal(formatBytes(-1), '—')
})

// --- PVC 用量:K8s 容量字符串 → 字节(用于 NFS 共享检测的 capacity vs requested 对比)---
test('parseSizeToBytes: 二进制后缀', () => {
  assert.equal(parseSizeToBytes('10Gi'), 10737418240)
  assert.equal(parseSizeToBytes('512Mi'), 536870912)
  assert.equal(parseSizeToBytes('1Ti'), 1099511627776)
  assert.equal(parseSizeToBytes('1.5Ti'), 1649267441664)
  assert.equal(parseSizeToBytes('1Ki'), 1024)
})

test('parseSizeToBytes: 十进制后缀与裸数字', () => {
  assert.equal(parseSizeToBytes('1K'), 1000)          // K8s:K/M/G 为十进制(1000 进)
  assert.equal(parseSizeToBytes('1M'), 1000000)
  assert.equal(parseSizeToBytes('1024'), 1024)
  assert.equal(parseSizeToBytes(2048), 2048)          // 数字入参
})

test('parseSizeToBytes: 非法 → null', () => {
  assert.equal(parseSizeToBytes('abc'), null)
  assert.equal(parseSizeToBytes(''), null)
  assert.equal(parseSizeToBytes(null), null)
  assert.equal(parseSizeToBytes(undefined), null)
})

// --- 集群汇总计数:从 Vue Query 缓存快照派生(computeClusterMetrics 用)---
test('deriveClusterCounts: 数组取长度(含空数组=0)', () => {
  assert.deepEqual(
    deriveClusterCounts({ nodes: [{}, {}], pods: [{}], events: [{}, {}, {}] }),
    { nodeCount: 2, podCount: 1, activeEvents: 3 }
  )
  assert.deepEqual(
    deriveClusterCounts({ nodes: [], pods: [], events: [] }),
    { nodeCount: 0, podCount: 0, activeEvents: 0 }
  )
})

test('deriveClusterCounts: 非数组/缺省 → null(未命中,供调用方回退)', () => {
  assert.deepEqual(deriveClusterCounts(), { nodeCount: null, podCount: null, activeEvents: null })
  assert.deepEqual(
    deriveClusterCounts({ nodes: null, pods: 'oops', events: undefined }),
    { nodeCount: null, podCount: null, activeEvents: null }
  )
  assert.deepEqual(
    deriveClusterCounts({ nodes: 42, pods: { x: 1 }, events: 0 }),
    { nodeCount: null, podCount: null, activeEvents: null }
  )
})

// --- 图表美化:MD3 色板单一来源 + var() 未定义 bug 修复 ---
import { MD_PALETTE, paletteVarsCss, installPaletteVars, tokenHex } from '../src/styles/md-palette.js'

test('MD_PALETTE: 必备 token 齐全且为 6 位 hex', () => {
  const need = ['primary', 'secondary', 'tertiary', 'tertiary-container', 'error', 'status-failed',
    'on-surface', 'on-surface-variant', 'outline', 'outline-variant',
    'surface-container-lowest', 'surface-container-high', 'primary-container', 'secondary-container']
  for (const k of need) assert.ok(/^#[0-9a-f]{6}$/i.test(MD_PALETTE[k] || ''), `token ${k} 缺失或非 #rrggbb`)
})
test('paletteVarsCss: :root 注入且含全仓实际使用的 4 个 --md-sys-color-* 变量', () => {
  const css = paletteVarsCss()
  assert.ok(css.startsWith(':root{'), '应为 :root{...} 形式')
  for (const v of ['--md-sys-color-primary', '--md-sys-color-secondary', '--md-sys-color-tertiary-container', '--md-sys-color-error']) {
    assert.ok(css.includes(v), `缺少 ${v}`)
  }
  assert.ok(css.includes(`--md-sys-color-primary:${MD_PALETTE.primary};`))
})
test('tokenHex: 已知 token→hex;未知/空回落 primary', () => {
  assert.equal(tokenHex('secondary'), MD_PALETTE.secondary)
  assert.equal(tokenHex('nope'), MD_PALETTE.primary)
  assert.equal(tokenHex(), MD_PALETTE.primary)
})
test('installPaletteVars: 幂等(重复调用不重复注入)', () => {
  let appended = 0
  const fakeDoc = { getElementById: () => (appended ? {} : null), head: { appendChild: () => { appended++ } }, createElement: () => ({ textContent: '' }) }
  installPaletteVars(fakeDoc)
  installPaletteVars(fakeDoc)
  assert.equal(appended, 1)
})

// --- 图表美化:ECharts option 纯构建器 ---
import { hexToRgba, relTimeLabel, buildAreaLineOption, buildDonutOption, buildGaugeOption, buildStatusSegments, STATUS_COLORS, formatRelTime, buildTimeAreaLineOption } from '../src/lib/chart-options.js'

test('hexToRgba: 6 位 hex → rgba;非法回落黑', () => {
  assert.equal(hexToRgba('#006c49', 0.35), 'rgba(0,108,73,0.35)')
  assert.equal(hexToRgba('nonsense', 0.5), 'rgba(0,0,0,0.5)')
})
test('relTimeLabel: 最新样本 0s、往前 -Ns', () => {
  assert.equal(relTimeLabel(0, 10), '0s')
  assert.equal(relTimeLabel(2, 10), '-20s')
  assert.equal(relTimeLabel(1, 30), '-30s')
})
test('buildAreaLineOption: 平滑线 + 面积渐变(0.35→0.02)+ 相对时间 tooltip', () => {
  const opt = buildAreaLineOption({ series: [10, 20, 15], color: 'primary', unit: '%' })
  const s = opt.series[0]
  assert.equal(s.type, 'line')
  assert.equal(s.smooth, true)
  assert.equal(s.symbol, 'none')
  assert.equal(s.areaStyle.color.colorStops[0].color, 'rgba(0,108,73,0.35)')
  assert.equal(s.areaStyle.color.colorStops[1].color, 'rgba(0,108,73,0.02)')
  assert.equal(opt.tooltip.formatter([{ dataIndex: 0, value: 10 }]), '-20s<br/>10%')
  assert.equal(opt.tooltip.formatter([{ dataIndex: 2, value: 15 }]), '0s<br/>15%')
  assert.ok(Array.isArray(opt.xAxis.data) && opt.xAxis.data.length === 3)
})
test('buildAreaLineOption: refLines 进 markLine 虚线、token 色已解析、计入 y 轴 max', () => {
  const opt = buildAreaLineOption({ series: [10, 12], color: 'primary', refLines: [
    { label: 'requests', value: 250, color: 'secondary' },
    { label: 'limits', value: 400, color: 'error' },
  ] })
  assert.equal(opt.yAxis.max, 400)
  assert.deepEqual(opt.series[0].markLine.data.map(d => d.yAxis), [250, 400])
  assert.equal(opt.series[0].markLine.data[0].lineStyle.type, 'dashed')
  assert.equal(opt.series[0].markLine.data[0].lineStyle.color, MD_PALETTE.secondary)
  assert.equal(opt.series[0].markLine.data[1].lineStyle.color, MD_PALETTE.error)
  assert.equal(opt.series[0].markLine.symbol, 'none')
})
test('buildAreaLineOption: spark 模式无网格线、无 markLine、贴边 grid', () => {
  const opt = buildAreaLineOption({ series: [1, 2, 3], spark: true, refLines: [{ label: 'x', value: 9, color: 'secondary' }] })
  assert.equal(opt.yAxis.splitLine.show, false)
  assert.equal(opt.series[0].markLine, undefined)
  assert.deepEqual(opt.grid, { left: 0, right: 0, top: 2, bottom: 0 })
})
test('buildStatusSegments: 三态计数、其余归 Other(count>0 才保留)', () => {
  const pods = [{ status: 'Running' }, { status: 'Running' }, { status: 'Pending' }, { status: 'Succeeded' }, { status: 'Unknown' }, {}]
  assert.deepEqual(buildStatusSegments(pods), [
    { status: 'Running', count: 2 },
    { status: 'Pending', count: 1 },
    { status: 'Other', count: 3 },
  ])
  assert.deepEqual(buildStatusSegments([]), [])
  assert.deepEqual(buildStatusSegments(), [])
})
test('buildDonutOption: 段色按 STATUS_COLORS 解析、圆角扇区、tooltip 文案', () => {
  const opt = buildDonutOption([{ status: 'Running', count: 3 }, { status: 'Failed', count: 1 }])
  assert.equal(opt.series[0].data[0].name, 'Running')
  assert.equal(opt.series[0].data[0].itemStyle.color, MD_PALETTE['status-running'])
  assert.equal(opt.series[0].data[1].itemStyle.color, MD_PALETTE['status-failed'])
  assert.ok(opt.series[0].itemStyle.borderRadius > 0)
  assert.equal(opt.series[0].label.show, false)
  assert.equal(opt.tooltip.formatter({ name: 'Running', value: 3, percent: 75 }), 'Running: 3 (75%)')
})
test('buildGaugeOption: 阈值三档色 + null 灰环空态 + 0-100 夹取 + 组件全隐', () => {
  const g = (v) => buildGaugeOption(v).series[0]
  assert.equal(g(90).progress.itemStyle.color.colorStops[0].color, MD_PALETTE.error)
  assert.equal(g(70).progress.itemStyle.color.colorStops[0].color, MD_PALETTE['tertiary-container'])
  assert.equal(g(30).progress.itemStyle.color.colorStops[0].color, MD_PALETTE.primary)
  assert.equal(g(null).progress.itemStyle.color.colorStops[0].color, MD_PALETTE['surface-container-high'])
  assert.equal(g(null).data[0].value, 0)
  assert.equal(g(150).data[0].value, 100)
  assert.equal(g(-5).data[0].value, 0)
  assert.equal(g(50).pointer.show, false)
  assert.equal(g(50).axisLabel.show, false)
  assert.equal(g(50).detail.show, false)
})
test('STATUS_COLORS 常量形状', () => {
  assert.equal(STATUS_COLORS.Running, 'status-running')
  assert.equal(STATUS_COLORS.Other, 'on-surface-variant')
})

// --- 指标采样全局化:滚动窗口纯逻辑 ---
import { WINDOW_MS, MAX_SAMPLES, pushSample, restoreSamples, persistPayload } from '../src/logic/metricsWindow.js'

test('pushSample: 追加新样本;越龄样本被丢弃(以 now 为准)', () => {
  const now = 10_000_000
  const fresh = pushSample([], { t: now, v: 3 }, { now })
  assert.deepEqual(fresh, [{ t: now, v: 3 }])
  // 越龄:比 now 早超过 maxAgeMs 的旧样本在 push 时一并清掉(默认 maxAge=15min)
  const base = [{ t: now - 5000, v: 1 }, { t: now - WINDOW_MS - 1000, v: 9 }]
  const out = pushSample(base, { t: now, v: 3 }, { now })
  assert.deepEqual(out, [{ t: now - 5000, v: 1 }, { t: now, v: 3 }])
})

test('pushSample: maxCount 尾部截断(保最新)', () => {
  const now = 5_000_000
  let arr = []
  for (let i = 0; i < 205; i++) arr = pushSample(arr, { t: now + i, v: i }, { now, maxCount: 180 })
  assert.equal(arr.length, 180)
  assert.equal(arr[arr.length - 1].v, 204)
  assert.equal(arr[0].v, 25)   // 丢掉最老的 25 个
})

test('pushSample: 不修改原数组(不可变)', () => {
  const base = [{ t: 1, v: 1 }]
  pushSample(base, { t: 2, v: 2 }, { now: 3 })
  assert.deepEqual(base, [{ t: 1, v: 1 }])
})

test('restoreSamples: 正常恢复 + 陈旧过滤 + 非法项过滤', () => {
  const now = 10_000_000
  const raw = [
    { t: now - 1000, v: 50 },            // 新鲜
    { t: now - WINDOW_MS - 5000, v: 40 }, // 陈旧 → 滤
    { t: 'x', v: 1 }, { v: 2 }, { t: 3 }, null, 42, // 非法 → 滤
  ]
  assert.deepEqual(restoreSamples(raw, { now }), [{ t: now - 1000, v: 50 }])
})

test('restoreSamples: 损坏入参全降级为 [] 不抛', () => {
  assert.deepEqual(restoreSamples(undefined, { now: 1 }), [])
  assert.deepEqual(restoreSamples(null, { now: 1 }), [])
  assert.deepEqual(restoreSamples('{"cpu":', { now: 1 }), [])   // 字符串当数组遍历不炸
  assert.deepEqual(restoreSamples({}, { now: 1 }), [])
})

test('persistPayload: 形状 {cpu,mem} 且深拷贝(改源不影响产物)', () => {
  const cpu = [{ t: 1, v: 1 }], mem = [{ t: 2, v: 2 }]
  const p = persistPayload(cpu, mem)
  assert.deepEqual(p, { cpu: [{ t: 1, v: 1 }], mem: [{ t: 2, v: 2 }] })
  p.cpu.push({ t: 9, v: 9 })
  assert.equal(cpu.length, 1)
})

test('常量: 15 分钟窗口 / 180 条上限', () => {
  assert.equal(WINDOW_MS, 900000)
  assert.equal(MAX_SAMPLES, 180)
})

// --- 指标采样全局化:时间轴 builder ---
test('formatRelTime: 0/秒/分钟档', () => {
  assert.equal(formatRelTime(0), '0s')
  assert.equal(formatRelTime(-5), '0s')            // 负数夹 0
  assert.equal(formatRelTime(40), '-40s')
  assert.equal(formatRelTime(200), '-3m20s')
  assert.equal(formatRelTime(180), '-3m')
})

test('buildTimeAreaLineOption: time 轴 + [t,v] 数据 + 相对最新样本的 tooltip', () => {
  const samples = [
    { t: 1_000_000, v: 10 },
    { t: 1_060_000, v: 20 },   // 比最新早 60s
    { t: 1_200_000, v: 15 },   // 最新
    { t: 'bad', v: 1 },        // 非法 → 滤
  ]
  const opt = buildTimeAreaLineOption({ samples, color: 'primary', unit: '%' })
  assert.equal(opt.xAxis.type, 'time')
  assert.deepEqual(opt.series[0].data, [[1_000_000, 10], [1_060_000, 20], [1_200_000, 15]])
  // tooltip:第一个点比最新(1_200_000)早 200s
  assert.equal(opt.tooltip.formatter([{ value: [1_000_000, 10], dataIndex: 0 }]), '-3m20s<br/>10%')
  assert.equal(opt.tooltip.formatter([{ value: [1_200_000, 15], dataIndex: 2 }]), '0s<br/>15%')
  assert.equal(opt.series[0].lineStyle.color, MD_PALETTE.primary)
  assert.equal(opt.series[0].areaStyle.color.colorStops[0].color, 'rgba(0,108,73,0.35)')
})

test('buildTimeAreaLineOption: refLines 进 markLine 且计入 y 轴 max', () => {
  const opt = buildTimeAreaLineOption({
    samples: [{ t: 1, v: 10 }, { t: 2, v: 12 }],
    refLines: [{ label: 'limits', value: 80, color: 'error' }],
  })
  assert.equal(opt.yAxis.max, 80)
  assert.equal(opt.series[0].markLine.data[0].yAxis, 80)
  assert.equal(opt.series[0].markLine.data[0].lineStyle.color, MD_PALETTE.error)
})

test('buildTimeAreaLineOption: spark=true 贴边 grid + 隐藏 splitLine(默认不受影响)', () => {
  const samples = [{ t: 1, v: 10 }, { t: 2, v: 12 }]
  const spark = buildTimeAreaLineOption({ samples, spark: true })
  assert.deepEqual(spark.grid, { left: 0, right: 0, top: 2, bottom: 0 })
  assert.deepEqual(spark.yAxis.splitLine, { show: false })
  const full = buildTimeAreaLineOption({ samples })
  assert.deepEqual(full.grid, { left: 4, right: 4, top: 8, bottom: 4 })
  assert.equal(full.yAxis.splitLine.show, undefined)
  assert.equal(full.yAxis.splitLine.lineStyle.width, 1)
})

test('buildTimeAreaLineOption: 空样本不崩(y 轴 max 回落 1)', () => {
  const opt = buildTimeAreaLineOption({ samples: [] })
  assert.deepEqual(opt.series[0].data, [])
  assert.equal(opt.yAxis.max, 1)
})

// --- 汇总 ---
const failed = results.filter(r => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}`)
}
if (failed.length) {
  console.error(`\n[test] ✗ ${failed.length}/${results.length} 用例失败：`)
  for (const r of failed) console.error('    -', r.name, '\n', r.err && r.err.stack ? r.err.stack : r.err)
  process.exit(1)
}
console.log(`\n[test] ✓ ${results.length} 用例全部通过。`)
