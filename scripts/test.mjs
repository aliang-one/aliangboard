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
import { buildIngressAnnotations } from '../src/composables/useIngressPerf.js'
import { yamlScalar } from '../src/composables/useYaml.js'
import { load } from 'js-yaml'

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

// --- K8s 资源量解析契约（镜像 stores/cluster.js 的 cpuToMilli/memToKi，锁定 metrics 解析行为）---
// 说明：测试运行器零依赖、无法 import 带 @/ 别名的 store，故按既有 base64 用例的惯例镜像逻辑作为契约。
// 若修改 store 中的解析器，请同步本镜像，使两处保持一致。
test('K8s 资源量解析：CPU→毫核、内存→Ki（覆盖各后缀与裸值）', () => {
  const cpuToMilli = q => {
    if (q == null || q === '') return 0
    const s = String(q).trim()
    if (s.endsWith('n')) return Math.round(Number(s.slice(0, -1)) / 1e6)
    if (s.endsWith('u')) return Math.round(Number(s.slice(0, -1)) / 1e3)
    if (s.endsWith('m')) return Number(s.slice(0, -1)) || 0
    const n = Number(s)
    return isNaN(n) ? 0 : n * 1000
  }
  const memToKi = q => {
    if (q == null || q === '') return 0
    const s = String(q).trim()
    const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/)
    if (!m) return 0
    const num = Number(m[1])
    const suf = m[2] || ''
    const mult = {
      Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3, Pi: 1024 ** 4, Ei: 1024 ** 5,
      k: 1000 / 1024, M: 1e6 / 1024, G: 1e9 / 1024, T: 1e12 / 1024, P: 1e15 / 1024, E: 1e18 / 1024,
    }
    return Math.round(num * (suf ? (mult[suf] ?? 1) : 1 / 1024))
  }
  // CPU：毫核 / 核 / 纳核（metrics-server 常返回纳核）/ 微核 / 空值
  assert.equal(cpuToMilli('500m'), 500)
  assert.equal(cpuToMilli('2'), 2000)
  assert.equal(cpuToMilli('868940n'), 1)      // 纳核 → 0.87m，四舍五入为 1m
  assert.equal(cpuToMilli('750u'), 1)         // 微核 → 0.75m，四舍五入为 1m
  assert.equal(cpuToMilli(''), 0)
  assert.equal(cpuToMilli(null), 0)
  // 内存：二进制后缀 / 裸字节
  assert.equal(memToKi('512Mi'), 524288)
  assert.equal(memToKi('1Gi'), 1048576)
  assert.equal(memToKi('1024Ki'), 1024)
  assert.equal(memToKi('1048576'), 1024)      // 无后缀视为裸字节
  assert.equal(memToKi(''), 0)
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
  // 默认值：空 path→'/'，空 pathType→'Prefix'，空 port→80
  const r4 = buildIngressRulesPatch([{ host: 'x', path: '', pathType: '', serviceName: 's', servicePort: '' }], null)
  assert.equal(r4.spec.rules[0].http.paths[0].path, '/')
  assert.equal(r4.spec.rules[0].http.paths[0].pathType, 'Prefix')
  assert.equal(r4.spec.rules[0].http.paths[0].backend.service.port.number, 80)
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
