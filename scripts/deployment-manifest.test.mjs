// deployment.yaml 结构契约 —— kubectl apply 单文件安装的回归防线
// 值与 spec(docs/superpowers/specs/2026-08-14-k8s-single-file-deploy-design.md)一一对应,改动前先改 spec。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadAll } from 'js-yaml'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const raw = readFileSync(join(ROOT, 'deployment.yaml'), 'utf8')
const docs = []
loadAll(raw, (doc) => docs.push(doc))

const byKind = (kind) => docs.filter((d) => d && d.kind === kind)
const [ns, pvc, deploy, svc] = ['Namespace', 'PersistentVolumeClaim', 'Deployment', 'Service'].map(
  (k) => byKind(k)[0]
)
const pod = deploy.spec.template.spec
const container = pod.containers[0]

test('manifest 含且仅含 4 个对象,全部落在 aliangboard 命名空间', () => {
  assert.equal(docs.filter(Boolean).length, 4)
  assert.equal(ns.metadata.name, 'aliangboard')
  for (const d of [pvc, deploy, svc]) {
    assert.equal(d.metadata.namespace, 'aliangboard')
    assert.equal(d.metadata.name, 'aliangboard' + (d.kind === 'PersistentVolumeClaim' ? '-data' : ''))
  }
})

test('PVC: 1Gi RWO,不指定 storageClassName(走集群默认动态供给)', () => {
  assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce'])
  assert.equal(pvc.spec.resources.requests.storage, '1Gi')
  assert.equal('storageClassName' in pvc.spec, false)
})

test('Deployment: 单副本 + Recreate(SQLite/RWO 禁双活)', () => {
  assert.equal(deploy.spec.replicas, 1)
  assert.equal(deploy.spec.strategy.type, 'Recreate')
  assert.equal(deploy.spec.selector.matchLabels.app, 'aliangboard')
  assert.equal(deploy.spec.template.metadata.labels.app, 'aliangboard')
})

test('Deployment: 镜像与拉取策略(owner=aliang-one)', () => {
  assert.equal(container.image, 'ghcr.io/aliang-one/aliangboard:latest')
  assert.equal(container.imagePullPolicy, 'Always')
})

test('Deployment: 探针打无鉴权健康端点 /api/health(命名端口 http=8787)', () => {
  const httpPort = container.ports.find((p) => p.name === 'http')
  assert.equal(httpPort.containerPort, 8787)
  for (const probe of [container.readinessProbe, container.livenessProbe]) {
    assert.equal(probe.httpGet.path, '/api/health')
    assert.equal(probe.httpGet.port, 'http')
  }
  assert.equal(container.readinessProbe.initialDelaySeconds, 5)
  assert.equal(container.livenessProbe.initialDelaySeconds, 10)
  assert.equal(container.livenessProbe.failureThreshold, 6)
})

test('Deployment: 安全上下文(runAsNonRoot/fsGroup 1000/收能力)', () => {
  assert.equal(pod.securityContext.runAsNonRoot, true)
  assert.equal(pod.securityContext.fsGroup, 1000)
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault')
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL'])
})

test('Deployment: 管理员凭证不落明文默认值 + 容器加固', () => {
  // 2026-08-28 CSO 审计 #3:出厂清单曾带字面 admin/admin(配合登录无限速=完整暴力破解链)。
  // 新姿态:清单不落任何 ADMIN_PASSWORD 字面值;ADMIN_* 只以注释引导 secretRef/自动生成。
  const adminPass = container.env.find((e) => e.name === 'ADMIN_PASSWORD')
  assert.ok(!adminPass, '清单不得带 ADMIN_PASSWORD 明文 env(用 secretRef 或留空自动生成)')
  for (const e of container.env) {
    assert.ok(!(e.name === 'ADMIN_USERNAME' && e.value === 'admin' && adminPass), '不得同时出厂用户名+口令字面值')
  }
  assert.equal(container.securityContext.allowPrivilegeEscalation, false)
  assert.equal(container.securityContext.runAsUser, 1000)
})

test('Deployment: 资源额度与显式 PORT', () => {
  assert.equal(container.resources.requests.cpu, '100m')
  assert.equal(container.resources.requests.memory, '128Mi')
  assert.equal(container.resources.limits.cpu, '500m')
  assert.equal(container.resources.limits.memory, '512Mi')
  const port = container.env.find((e) => e.name === 'PORT')
  assert.equal(port.value, '8787')
})

test('Deployment: 数据卷挂 /app/data 对齐 PVC', () => {
  const mount = container.volumeMounts.find((m) => m.mountPath === '/app/data')
  assert.ok(mount, '必须有 /app/data 挂载')
  const vol = pod.volumes.find((v) => v.name === mount.name)
  assert.equal(vol.persistentVolumeClaim.claimName, 'aliangboard-data')
})

test('Service: NodePort 自动分配(不写死端口),selector 对齐', () => {
  assert.equal(svc.spec.type, 'NodePort')
  const port = svc.spec.ports[0]
  assert.equal(port.port, 8787)
  assert.equal(port.targetPort, 'http')
  assert.equal('nodePort' in port, false)
  assert.equal(svc.spec.selector.app, 'aliangboard')
})
