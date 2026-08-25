// 子容器领域模块:模型默认/表单→spec 构建(omitempty 与 nullAbsent)/挂载过滤/计数/空行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSubContainer, buildSubContainerSpec, mountsForTarget, advancedCount, isSubContainerEmpty } from './subContainer.js'

const FULL = () => ({
  ...makeSubContainer(),
  name: 'sc', image: 'nginx:1', command: 'sh -c "x"', args: 'a\nb',
  workingDir: '/w', pullPolicy: 'Always', stdin: true, tty: true,
  envVars: [{ key: 'K', value: 'V' }],
  envFromConfigMap: 'cm1', envFromSecret: 'sec1',
  envCMKeys: [{ name: 'A', cmName: 'cm2', key: 'k' }],
  envSecretKeys: [{ name: 'B', secretName: 's2', key: 'k' }],
  ports: [{ containerPort: 9090, protocol: 'UDP' }],
  liveness: { enabled: true, type: 'http', httpPath: '/h', port: 8080, execCommand: '', initialDelaySeconds: 1, periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  lifecycle: { postStart: 'echo hi', preStop: '' },
  securityContext: { enabled: true, privileged: false, runAsUser: '1000', runAsGroup: '', runAsNonPrivileged: true, readOnlyRootFilesystem: false, addCaps: 'NET_ADMIN', dropCaps: '' },
  nativeSidecar: true,
})

test('makeSubContainer: 全默认形状(资源默认值与现状卡片一致)', () => {
  const c = makeSubContainer()
  assert.equal(c.cpuRequest, '100m'); assert.equal(c.cpuLimit, '250m')
  assert.equal(c.memoryRequest, '128Mi'); assert.equal(c.memoryLimit, '256Mi')
  assert.deepEqual(c.envVars, []); assert.deepEqual(c.ports, [])
  assert.equal(c.liveness.enabled, false); assert.equal(c.liveness.initialDelaySeconds, 30)
  assert.equal(c.readiness.initialDelaySeconds, 5); assert.equal(c.startup.initialDelaySeconds, 0)
  assert.equal(c.securityContext.enabled, false); assert.equal(c.nativeSidecar, false)
})

test('buildSubContainerSpec: 全字段 omitempty 构建正确', () => {
  const o = buildSubContainerSpec(FULL(), { fallbackName: 'fb', mounts: [{ name: 'v', mountPath: '/d' }] })
  assert.equal(o.name, 'sc'); assert.equal(o.image, 'nginx:1')
  assert.deepEqual(o.command, ['sh', '-c', 'x']); assert.deepEqual(o.args, ['a', 'b'])
  assert.equal(o.workingDir, '/w'); assert.equal(o.imagePullPolicy, 'Always')
  assert.equal(o.stdin, true); assert.equal(o.tty, true)
  assert.deepEqual(o.resources, { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '250m', memory: '256Mi' } })
  assert.deepEqual(o.ports, [{ containerPort: 9090, protocol: 'UDP' }])
  assert.deepEqual(o.env, [
    { name: 'K', value: 'V' },
    { name: 'A', valueFrom: { configMapKeyRef: { name: 'cm2', key: 'k' } } },
    { name: 'B', valueFrom: { secretKeyRef: { name: 's2', key: 'k' } } },
  ])
  assert.deepEqual(o.envFrom, [{ configMapRef: { name: 'cm1' } }, { secretRef: { name: 'sec1' } }])
  assert.deepEqual(o.livenessProbe, { initialDelaySeconds: 1, periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1, httpGet: { path: '/h', port: 8080 } })
  assert.deepEqual(o.lifecycle, { postStart: { exec: { command: ['echo', 'hi'] } } })
  assert.deepEqual(o.securityContext, { runAsUser: 1000, runAsNonRoot: true, capabilities: { add: ['NET_ADMIN'] } })
  assert.deepEqual(o.volumeMounts, [{ name: 'v', mountPath: '/d' }])
  assert.equal(o.restartPolicy, 'Always')
})

test('buildSubContainerSpec: 空容器 omitempty 只发 name/image(带 fallback;资源默认值清空后)', () => {
  const bare = { ...makeSubContainer(), image: 'nginx', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }
  const o = buildSubContainerSpec(bare, { fallbackName: 'fb' })
  assert.deepEqual(Object.keys(o).sort(), ['image', 'name'])
  assert.equal(o.name, 'fb')
})

test('buildSubContainerSpec: nullAbsent 编辑语义——可选空字段显式 null,stdin/tty 显式布尔', () => {
  const cleared = { ...makeSubContainer(), image: 'nginx', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }
  const o = buildSubContainerSpec(cleared, { nullAbsent: true })
  for (const k of ['command', 'args', 'workingDir', 'imagePullPolicy', 'resources', 'ports', 'env', 'envFrom', 'livenessProbe', 'readinessProbe', 'startupProbe', 'lifecycle', 'securityContext', 'volumeMounts', 'restartPolicy']) {
    assert.ok(k in o, `${k} 应显式存在`); assert.equal(o[k], null, `${k} 应为 null`)
  }
  assert.equal(o.stdin, false); assert.equal(o.tty, false)
  // 全填时 nullAbsent 不覆盖真实值
  const full = buildSubContainerSpec(FULL(), { nullAbsent: true })
  assert.equal(full.workingDir, '/w'); assert.equal(full.restartPolicy, 'Always')
})

test('buildSubContainerSpec: 半填资源只发存在的档位;空行资源不发', () => {
  const o = buildSubContainerSpec({ ...makeSubContainer(), image: 'n', cpuRequest: '', cpuLimit: '1', memoryRequest: '', memoryLimit: '' })
  assert.deepEqual(o.resources, { limits: { cpu: '1' } })
  const bare = buildSubContainerSpec({ ...makeSubContainer(), image: 'n', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' })
  assert.ok(!('resources' in bare))
})

test('mountsForTarget: 按 target 过滤且丢残行;subPath/readOnly 透传', () => {
  const rows = [
    { target: 'init:0', name: 'a', mountPath: '/a', subPath: 's', readOnly: true },
    { target: 'main', name: 'b', mountPath: '/b' },
    { target: 'init:0', name: '', mountPath: '/c' },
  ]
  assert.deepEqual(mountsForTarget(rows, 'init:0'), [{ name: 'a', mountPath: '/a', subPath: 's', readOnly: true }])
  assert.equal(mountsForTarget(rows, 'sidecar:1'), null)
})

test('advancedCount: 计已配置条目', () => {
  assert.equal(advancedCount(makeSubContainer()), 0)
  const c = FULL()
  // env 1 + cm 1 + secret 1 + envFrom 2 + ports 1 + liveness 1 + postStart 1 + sc 1
  // + workingDir/pullPolicy/stdin/tty/native 各 1 = 14
  assert.equal(advancedCount(c), 14)
})

test('isSubContainerEmpty: 4 基础字段空但高级字段有值 → 非空行', () => {
  assert.equal(isSubContainerEmpty(makeSubContainer()), true)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), name: 'x' }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), envVars: [{ key: '', value: '' }] }), true)   // 残行不算
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), envVars: [{ key: 'K', value: '' }] }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), ports: [{ containerPort: '', protocol: 'TCP' }] }), true)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), ports: [{ containerPort: 80, protocol: 'TCP' }] }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), liveness: { ...makeSubContainer().liveness, enabled: true } }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), nativeSidecar: true }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), securityContext: { ...makeSubContainer().securityContext, enabled: true } }), false)
})
