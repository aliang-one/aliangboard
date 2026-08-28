// cluster store · YAML 域(Plan 5 拆分,2026-08-28):generateYAML/generateExtraYAML(表单→无损清单)、
// CR 实例 YAML/路径、refreshCRDInstances/applyCRYaml/deleteCRInstance、通用 applyResourceYaml、
// checkAccessServer。自 cluster.js 逐字搬迁(仅 currentNamespace.value → getCurrentNamespace() 注入),
// store 公开名不变。依赖注入而非闭包引用——2026-08-09 mapper 抽取白屏事故的教训。
import { loadAll as yamlLoadAll } from 'js-yaml'
import { api } from '@/api/client'
import { i18n } from '@/i18n'
import { yamlScalar, ensureServicePortNames } from '@/composables/useYaml'
import { decodeBase64 } from '@/composables/useResourceMappers'
import { buildStorageClassYaml } from '@/data/storageClassYaml'
import { queryClient } from '@/queryClient'

// YAML 强制双引号序列化:metadata.name/namespace/标签值/容器名等必须是字符串,
// 裸 ${name} 在 name 形如数字(如 123)时会被 YAML 解析成 int → K8s "expected string"。
// generateYAML/generateExtraYAML 的 name/namespace 插值统一用它包一层。
const yamlQ = v => JSON.stringify(String(v ?? ''))

export function createYamlDomain({ getCurrentNamespace }) {
  // === Generate YAML for a resource ===
  function generateYAML(type, resource) {
    if (!resource) return ''
    const ns = resource.namespace || getCurrentNamespace()
    const name = resource.name
    // 标量序列化：含换行走 block scalar(|-)，含特殊字符走双引号转义，否则裸值。
    // ConfigMap data / Secret stringData / Ingress 注解等任意用户值都应走它，避免 " 或换行破坏 YAML。
    // 复用共享 useYaml.yamlScalar（cluster.js 与 DeployApp 向导统一同一份实现）。
    const scalar = yamlScalar

    if (type === 'service') {
      const isExtName = resource.type === 'ExternalName'
      // 端口：优先用结构化 portList（含 name/nodePort/appProtocol，无损），否则解析扁平 ports 字符串
      let portSrc = (!isExtName && resource.portList?.length)
        ? resource.portList
        : (!isExtName ? String(resource.ports || '80:80/TCP').split(',').filter(Boolean).map(p => {
            const m = String(p).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/) || [, 80, 80, 'TCP']
            return { name: '', port: Number(m[1]) || 80, targetPort: isNaN(m[2]) ? m[2] : Number(m[2]), protocol: m[3] || 'TCP', nodePort: null, appProtocol: '' }
          }) : [])
      // K8s 校验:多端口 Service 每个 port 都必须有 name(spec.ports[i].name: Required value)。
      // 空名自动补 port-<端口号>(重号加序号);单端口匿名无损;不动调用方对象(防缓存污染)。
      // 单一事实源在 useYaml.ensureServicePortNames,与 DeployApp 向导共用(2026-08-17 前曾各自为政漏向导)。
      portSrc = ensureServicePortNames(portSrc)
      const portsYaml = portSrc.map(p => {
        const tgt = p.targetPort
        const lines = [`    - port: ${p.port}`]
        if (p.name) lines.push(`      name: ${p.name}`)
        if (tgt != null && tgt !== '') lines.push(`      targetPort: ${isNaN(tgt) ? tgt : Number(tgt)}`)
        lines.push(`      protocol: ${p.protocol || 'TCP'}`)
        if (p.appProtocol) lines.push(`      appProtocol: ${p.appProtocol}`)
        if (p.nodePort) lines.push(`      nodePort: ${p.nodePort}`)
        return lines.join('\n')
      }).join('\n')
      const selObj = resource.selector || {}
      const selEntries = Object.keys(selObj).length
        ? Object.entries(selObj).map(([k, v]) => `    ${k}: ${v}`).join('\n')
        : (!isExtName ? `    app: ${yamlQ(name)}` : '')
      const selBlock = selEntries ? `\n  selector:\n${selEntries}` : ''
      const portsBlock = portSrc.length ? `\n  ports:\n${portsYaml}` : ''
      // 可选 spec 字段：仅在有值 / 非默认时输出，保持无损且不污染默认服务
      const extras = []
      if (isExtName && resource.externalName) extras.push(`  externalName: ${resource.externalName}`)
      if (resource.sessionAffinity && resource.sessionAffinity !== 'None') {
        extras.push(`  sessionAffinity: ${resource.sessionAffinity}`)
        if (resource.sessionAffinityTimeout != null) extras.push(`  sessionAffinityConfig:\n    clientIP:\n      timeoutSeconds: ${resource.sessionAffinityTimeout}`)
      }
      if (resource.externalTrafficPolicy) extras.push(`  externalTrafficPolicy: ${resource.externalTrafficPolicy}`)
      if (resource.internalTrafficPolicy && resource.internalTrafficPolicy !== 'Cluster') extras.push(`  internalTrafficPolicy: ${resource.internalTrafficPolicy}`)
      if (resource.publishNotReadyAddresses) extras.push(`  publishNotReadyAddresses: true`)
      const extraYaml = extras.length ? '\n' + extras.join('\n') : ''
      return `apiVersion: v1
kind: Service
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  type: ${resource.type || 'ClusterIP'}${selBlock}${portsBlock}${extraYaml}`
    }

    if (type === 'ingress') {
      // 优先从规范 rules 数组生成，保证多 host/多 path 回写无损
      const rules = (resource.rules && resource.rules.length) ? resource.rules : [{
        host: resource.hosts,
        http: { paths: [{ path: resource.path || '/', pathType: 'Prefix', backend: { serviceName: resource.backend?.split(':')[0], servicePort: Number(resource.backend?.split(':')[1]) || 80 } }] },
      }]
      const firstHost = rules[0]?.host || resource.hosts || ''
      // tlsList(多 host TLS,③ per-host 创建)优先;存量单 tls 布尔兜底(② 与其他调用方不变)
      const tlsBlock = resource.tlsList?.length
        ? '\n  tls:\n' + resource.tlsList.map(e => `  - hosts:\n    - ${e.hosts[0]}\n    secretName: ${e.secretName}`).join('\n')
        : (resource.tls ? `\n  tls:\n  - hosts:\n    - ${firstHost}\n    secretName: ${resource.tlsSecret || name + '-tls'}` : '')
      const rulesYaml = rules.map(r => {
        const pathsYaml = (r.http?.paths || []).map(p => {
          const be = p.backend?.service || p.backend
          const svcName = be?.name ?? be?.serviceName
          const portNum = be?.port?.number ?? be?.servicePort ?? be?.port
          return `      - path: ${p.path || '/'}
        pathType: ${p.pathType || 'Prefix'}
        backend:
          service:
            name: ${svcName || name + '-svc'}
            port:
              number: ${portNum || 80}`
        }).join('\n')
        return `  - host: ${r.host}
    http:
      paths:
${pathsYaml}`
      }).join('\n')
      const labelsYaml = resource.labels && Object.keys(resource.labels).length
        ? '\n  labels:\n' + Object.entries(resource.labels).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const annYaml = resource.annotations && Object.keys(resource.annotations).length
        ? '\n  annotations:\n' + Object.entries(resource.annotations).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      // ingressClassName 仅在显式指定时写入；未指定则省略，由集群默认 IngressClass 接管（避免硬编码 nginx 指向不存在的类）
      const classNameLine = resource.className ? `\n  ingressClassName: ${resource.className}` : ''
      return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${labelsYaml}${annYaml}
spec:${classNameLine}${tlsBlock}
  rules:
${rulesYaml}`
    }

    if (type === 'configmap') {
      const fmtMap = obj => obj && Object.keys(obj).length
        ? Object.entries(obj).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const labelsYaml = fmtMap(resource.labels)
      const annYaml = fmtMap(resource.annotations)
      const metaExtra = [
        labelsYaml && '  labels:\n' + labelsYaml,
        annYaml && '  annotations:\n' + annYaml,
      ].filter(Boolean).join('\n')
      const dataEntries = resource.data ? Object.entries(resource.data)
        .map(([k, v]) => `  ${k}: ${scalar(v)}`).join('\n') : ''
      return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${metaExtra ? '\n' + metaExtra : ''}
data:
${dataEntries || '  {}'}`
    }

    if (type === 'secret') {
      // 展示为 stringData（明文）以便直接编辑；回写时由 applyResourceYaml 重新 base64 编码
      const fmtMap = obj => obj && Object.keys(obj).length
        ? Object.entries(obj).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const metaExtra = [
        fmtMap(resource.labels) && '  labels:\n' + fmtMap(resource.labels),
        fmtMap(resource.annotations) && '  annotations:\n' + fmtMap(resource.annotations),
      ].filter(Boolean).join('\n')
      const dataEntries = resource.data
        ? Object.entries(resource.data).map(([k, v]) => `  ${k}: ${scalar(decodeBase64(v))}`).join('\n')
        : ''
      return `apiVersion: v1
kind: Secret
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${metaExtra ? '\n' + metaExtra : ''}
type: ${resource.type || 'Opaque'}
stringData:
${dataEntries || '  {}'}`
    }

    if (type === 'pvc') {
      const ACCESS_MODES = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }
      const accessMode = ACCESS_MODES[resource.accessModes] || resource.accessModes || 'ReadWriteOnce'
      const volumeName = resource.volume ? `\n  volumeName: ${resource.volume}` : ''
      return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  accessModes:
    - ${accessMode}
  resources:
    requests:
      storage: ${resource.capacity || '10Gi'}
  storageClassName: ${resource.storageClass || 'standard'}${volumeName}`
    }

    if (type === 'pv') {
      const ACCESS_MODES = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }
      const accessMode = ACCESS_MODES[resource.accessModes] || resource.accessModes || 'ReadWriteOnce'
      const [claimNs, claimName] = (resource.claim || '').split('/')
      const claimRef = claimName ? `\n  claimRef:\n    name: ${claimName}\n    namespace: ${claimNs || 'default'}` : ''
      return `apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${yamlQ(name)}
spec:
  capacity:
    storage: ${resource.capacity || '10Gi'}
  accessModes:
    - ${accessMode}
  persistentVolumeReclaimPolicy: ${resource.reclaimPolicy || 'Retain'}
  storageClassName: ${resource.storageClass || 'standard'}${claimRef}`
    }

    if (type === 'storageclass') {
      return buildStorageClassYaml(resource)
    }

    if (type === 'deployment') {
      const kind = resource.type || 'Deployment'
      const img = resource.image || 'nginx:latest'
      const desired = resource.replicas?.split('/')[1] || 1
      // Pod 模板（各工作负载共用）
      const podTemplate = `    metadata:
      labels:
        app: ${yamlQ(name)}
    spec:
      containers:
      - name: ${yamlQ(resource.name)}
        image: ${img}
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi`

      // CronJob：batch/v1，schedule + jobTemplate，无 replicas
      if (kind === 'CronJob') {
        const tpl = podTemplate.split('\n').map(l => '    ' + l).join('\n')
        return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  schedule: "${resource.schedule || '*/5 * * * *'}"
  jobTemplate:
    spec:
      template:
${tpl}`
      }

      // Job：batch/v1，completions/parallelism/backoffLimit，无 replicas
      if (kind === 'Job') {
        return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  backoffLimit: 6
  completions: ${resource.completions || 1}
  parallelism: 1
  template:
${podTemplate}`
      }

      // DaemonSet：apps/v1，按节点调度，无 replicas，用 updateStrategy
      if (kind === 'DaemonSet') {
        return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  selector:
    matchLabels:
      app: ${yamlQ(name)}
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
${podTemplate}`
      }

      // Deployment / StatefulSet
      return `apiVersion: apps/v1
kind: ${kind}
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  replicas: ${desired}
  selector:
    matchLabels:
      app: ${yamlQ(name)}
  template:
${podTemplate}`
    }

    if (type === 'networkpolicy') {
      const peerYaml = f => {
        const t = f.type || 'podSelector'
        if (t === 'ipBlock') return `      - ipBlock:\n          cidr: ${f.cidr || '0.0.0.0/0'}`
        const entries = f.matchLabels ? Object.entries(f.matchLabels) : []
        if (!entries.length) return `      - ${t}: {}`
        return `      - ${t}:
          matchLabels:
${entries.map(([k, v]) => `            ${k}: ${v}`).join('\n')}`
      }
      const ingressRules = resource.ingressRules?.length
        ? resource.ingressRules.map(r => `    - from:\n${(r.from || []).map(peerYaml).join('\n')}`).join('\n')
        : '    []'
      const egressRules = resource.egressRules?.length
        ? resource.egressRules.map(r => `    - to:\n${(r.to || []).map(peerYaml).join('\n')}`).join('\n')
        : '    []'
      return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  podSelector:
    matchLabels:
${Object.entries(resource.podSelector || {}).map(([k,v]) => `      ${k}: ${v}`).join('\n') || '      {}'}
  policyTypes:
${resource.policyTypes?.map(t => `  - ${t}`).join('\n') || '  - Ingress\n  - Egress'}
  ingress:
${ingressRules}
  egress:
${egressRules}`
    }

    if (type === 'hpa') {
      return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: ${resource.targetKind || 'Deployment'}
    name: ${resource.targetName || name}
  minReplicas: ${resource.minReplicas || 1}
  maxReplicas: ${resource.maxReplicas || 10}
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: ${resource.cpuTarget || 80}
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: ${resource.memoryTarget || 80}`
    }

    if (type === 'resourcequota') {
      const hardPairs = resource.hard ? Object.entries(resource.hard)
        .map(([k, v]) => `    ${k}: ${scalar(v)}`) : []
      const hardBlock = hardPairs.length ? hardPairs.join('\n') : '    {}'
      return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: "${name}"
  namespace: "${ns}"
spec:
  hard:
${hardBlock}`
    }

    if (type === 'limitrange') {
      return `apiVersion: v1
kind: LimitRange
metadata:
  name: "${name}"
  namespace: "${ns}"
spec:
  limits:
  - type: Container
    default:
      cpu: "${resource.defaultCPU || '500m'}"
      memory: "${resource.defaultMemory || '512Mi'}"
    defaultRequest:
      cpu: "${resource.defaultRequestCPU || '250m'}"
      memory: "${resource.defaultRequestMemory || '256Mi'}"
    max:
      cpu: "${resource.maxCPU || '2'}"
      memory: "${resource.maxMemory || '4Gi'}"
    min:
      cpu: "${resource.minCPU || '50m'}"
      memory: "${resource.minMemory || '64Mi'}"`
    }

    if (type === 'role') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: ${resource.scope === 'Cluster' ? 'ClusterRole' : 'Role'}
metadata:
  name: ${yamlQ(name)}
${resource.scope !== 'Cluster' ? `  namespace: ${yamlQ(ns)}` : ''}
rules:
${resource.rules?.map(r => `- apiGroups: [${(r.apiGroups || ['']).map(g => `"${g}"`).join(', ')}]
  resources: [${(r.resources || []).map(r => `"${r}"`).join(', ')}]
  verbs: [${(r.verbs || []).map(v => `"${v}"`).join(', ')}]`).join('\n') || '- apiGroups: [""]\n  resources: ["pods"]\n  verbs: ["get", "list"]'}`
    }

    if (type === 'serviceaccount') {
      return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}`
    }

    if (type === 'rolebinding') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
subjects:
${resource.subjects?.map(s => `- kind: ${s.kind || 'User'}
  name: ${s.name}
  ${s.namespace ? `namespace: ${s.namespace}` : ''}`).join('\n') || '- kind: User\n  name: default'}
roleRef:
  kind: ${resource.roleKind || 'Role'}
  name: ${resource.roleName || name}
  apiGroup: rbac.authorization.k8s.io`
    }

    if (type === 'clusterrolebinding') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${yamlQ(name)}
subjects:
${resource.subjects?.map(s => `- kind: ${s.kind || 'User'}
  name: ${s.name}${s.namespace ? `\n  namespace: ${s.namespace}` : ''}`).join('\n') || '- kind: User\n  name: default'}
roleRef:
  kind: ${resource.roleKind || 'ClusterRole'}
  name: ${resource.roleName || name}
  apiGroup: rbac.authorization.k8s.io`
    }

    if (type === 'ingressclass') {
      const def = resource.isDefault ? '\n  annotations:\n    ingressclass.kubernetes.io/is-default-class: "true"' : ''
      return `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: ${yamlQ(name)}${def}
spec:
  controller: ${resource.controller || 'k8s.io/ingress-nginx'}`
    }

    if (type === 'runtimeclass') {
      return `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: ${yamlQ(name)}
spec:
  handler: ${resource.handler || 'runc'}`
    }

    if (type === 'endpoints') {
      const addresses = resource.addresses || []
      const notReady = resource.notReadyAddresses || []
      const ports = resource.ports || []
      const addrYaml = addresses.length ? '\n' + addresses.map(a => `  - ip: ${a}`).join('\n') : ' []'
      const notReadyYaml = notReady.length ? `\n  notReadyAddresses:\n${notReady.map(a => `  - ip: ${a}`).join('\n')}` : ''
      // 端口 name 无损回写(NsEndpoints 的 YAML 编辑器内容即本函数产出,丢 name 会破坏
      // 已有多端口 Endpoints 的编辑保存;匿名端口保持匿名,不擅自补名——须与 Service 端口名对应)
      const portsYaml = ports.length ? '\n' + ports.map(p => `  - port: ${p.port}` + (p.name ? `\n    name: ${p.name}` : '') + `\n    protocol: ${p.protocol || 'TCP'}`).join('\n') : ' []'
      return `apiVersion: v1
kind: Endpoints
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
subsets:
- addresses:${addrYaml}${notReadyYaml}
  ports:${portsYaml}`
    }

    if (type === 'node') {
      return `apiVersion: v1
kind: Node
metadata:
  name: ${yamlQ(name)}
  labels:
    kubernetes.io/role: ${resource.roles || 'worker'}
    kubernetes.io/os: linux
    kubernetes.io/arch: amd64
spec:
  ${resource.unschedulable ? 'unschedulable: true' : 'unschedulable: false'}
status:
  conditions:
${Object.entries(resource.conditions || {}).map(([k, v]) => `  - type: ${k}\n    status: "${v}"`).join('\n')}`
    }

    return `# YAML for ${type}/${yamlQ(name)}`
  }

  // 单独的 YAML 生成（PDB / PriorityClass），避免破坏上面的逻辑
  function generateExtraYAML(type, resource) {
    if (!resource) return ''
    if (type === 'pdb') {
      const sel = resource.selector ? Object.entries(resource.selector).map(([k, v]) => `      ${k}: ${v}`).join('\n') : '      {}'
      return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: "${resource.name}"
  namespace: "${resource.namespace}"
spec:
  ${resource.minAvailable ? `minAvailable: ${resource.minAvailable}` : `maxUnavailable: ${resource.maxUnavailable}`}
  selector:
    matchLabels:
${sel}`
    }
    if (type === 'priorityclass') {
      return `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ${yamlQ(resource.name)}
value: ${resource.value}
globalDefault: ${resource.globalDefault}
description: "${resource.description || ''}"`
    }
    return ''
  }

  // === 通用 YAML 应用（kubectl edit / apply 语义）===
  // 解析编辑后的 YAML → 按 kind 转换为扁平字段 → 调用对应 updateXxx。
  // 这样所有资源都具备与真实 K8s 一致的「编辑 YAML 即生效」能力。
  const ACCESS_MODE_TO_CODE = { ReadWriteOnce: 'RWO', ReadWriteMany: 'RWM', ReadOnlyMany: 'ROM', ReadWriteOncePod: 'RWOP' }
  const CODE_TO_ACCESS_MODE = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }

  // canonical NetworkPolicy peer → 前端 peer 结构
  const toPeer = (p) => {
    if (p.podSelector) return { type: 'podSelector', matchLabels: p.podSelector.matchLabels || {} }
    if (p.namespaceSelector) return { type: 'namespaceSelector', matchLabels: p.namespaceSelector.matchLabels || {} }
    if (p.ipBlock) return { type: 'ipBlock', cidr: p.ipBlock.cidr }
    return { type: 'podSelector', matchLabels: {} }
  }

  // 自定义资源（CR）的 YAML 生成：CRD 的 group/version/kind + 实例元数据；
  // spec 用按 kind 的模板填充（实例本身只存 name/namespace/status/age）。
  const CR_SPEC_TEMPLATES = {
    Certificate: inst => `  secretName: ${inst.name}-tls\n  issuerRef:\n    name: letsencrypt-prod\n    kind: Issuer\n  dnsNames:\n  - ${inst.name}.kubezen.io`,
    Issuer: () => '  acme:\n    server: https://acme-v02.api.letsencrypt.org/directory\n    email: admin@kubezen.io\n    privateKeySecretRef:\n      name: letsencrypt-prod',
    ClusterIssuer: () => '  acme:\n    server: https://acme-v02.api.letsencrypt.org/directory\n    email: admin@kubezen.io',
    AlertmanagerConfig: () => '  route:\n    receiver: default\n    group_by: ["alertname"]\n  receivers:\n  - name: default',
  }
  function generateCRYaml(crd, inst) {
    if (!crd || !inst) return ''
    const meta = crd.namespaced && inst.namespace
      ? `metadata:\n  name: ${inst.name}\n  namespace: ${inst.namespace}`
      : `metadata:\n  name: ${inst.name}`
    const specBody = CR_SPEC_TEMPLATES[crd.kind] ? CR_SPEC_TEMPLATES[crd.kind](inst) : '  {}'
    return `apiVersion: ${crd.group}/${crd.version}
kind: ${crd.kind}
${meta}
spec:
${specBody}
status:
  phase: ${inst.status || 'Ready'}`
  }

  // 某个 CR 实例在 API 上的路径（cluster-scoped vs namespaced 两种形态）
  function crInstancePath(crd, inst) {
    if (!crd) return ''
    const plural = crd.name?.split('.')[0]
    const gv = `/apis/${crd.group}/${crd.version}`
    return crd.namespaced
      ? `${gv}/namespaces/${encodeURIComponent(inst?.namespace || 'default')}/${plural}/${encodeURIComponent(inst?.name)}`
      : `${gv}/${plural}/${encodeURIComponent(inst?.name)}`
  }

  // 重新拉取某个 CRD 的全部实例（CR 增删改后刷新局部，不必全量 hydrate）
  async function refreshCRDInstances(crdName) {
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === 'crds' && q.queryKey[3] === crdName && q.queryKey[4] === 'instances' })
  }

  // 通用 CR apply（server-side apply，适用于任意 CRD kind）+ 局部刷新
  async function applyCRYaml(crdName, yamlStr) {
    try {
      let object = null
      yamlLoadAll(yamlStr, d => { if (!object && d) object = d })
      const result = await api.applyYaml(yamlStr)
      const resource = result?.resources?.[0]
      await refreshCRDInstances(crdName)
      return { ok: true, kind: resource?.kind || object?.kind, name: resource?.metadata?.name || object?.metadata?.name }
    } catch (error) {
      return { ok: false, error: error.message || i18n.global.t('store.applyYamlFailed') }
    }
  }

  // 删除某个 CR 实例 + 局部刷新
  async function deleteCRInstance(crd, inst) {
    await api.k8s(crInstancePath(crd, inst), { method: 'DELETE' })
    await refreshCRDInstances(crd.name)
  }

  // can-i 服务端真值：SelfSubjectAccessReview。
  // 注意 SSAR 只判定「当前登录用户」（subjectName 无关）；任意 subject 的本地推演仍用 checkAccess。
  const RESOURCE_TO_GROUP = {
    pods: '', services: '', configmaps: '', secrets: '', serviceaccounts: '',
    persistentvolumeclaims: '', persistentvolumes: '', nodes: '', namespaces: '',
    endpoints: '', events: '',
    deployments: 'apps', statefulsets: 'apps', daemonsets: 'apps', replicasets: 'apps',
    ingresses: 'networking.k8s.io', networkpolicies: 'networking.k8s.io',
    roles: 'rbac.authorization.k8s.io', rolebindings: 'rbac.authorization.k8s.io',
    clusterroles: 'rbac.authorization.k8s.io', clusterrolebindings: 'rbac.authorization.k8s.io',
    jobs: 'batch', cronjobs: 'batch',
  }
  async function checkAccessServer({ verb, resource, namespace }) {
    // pods/log → resource=pods + subresource=log
    let name = String(resource || ''), subresource = ''
    if (name.includes('/')) { const [n, s] = name.split('/'); name = n; subresource = s }
    const group = RESOURCE_TO_GROUP[name] ?? ''
    const attrs = { verb: String(verb || 'get'), resource: name, group }
    if (namespace) attrs.namespace = namespace
    if (subresource) attrs.subresource = subresource
    const body = {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: attrs },
    }
    try {
      const r = await api.k8s('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', { method: 'POST', body: JSON.stringify(body) })
      return {
        ok: true,
        allowed: !!r?.status?.allowed,
        denied: !r?.status?.allowed,
        reason: r?.status?.reason || '',
        evaluationError: r?.status?.evaluationError || '',
      }
    } catch (e) {
      return { ok: false, error: e.message || i18n.global.t('store.ssarFailed') }
    }
  }

  async function applyResourceYaml(yamlStr) {
    try {
      let object = null
      yamlLoadAll(yamlStr, document => { if (!object && document) object = document })
      const result = await api.applyYaml(yamlStr) // { resources, applied, failed, total }
      queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' })
      const resource = result?.resources?.[0]
      const failed = result?.failed || []
      // applied 缺省(旧后端只回 resources)时回退用 resources 计数,避免新版前端+旧后端误报失败
      const appliedCount = result?.applied?.length ?? result?.resources?.length ?? 0
      // 全失败(http 422 已抛错,理论不至此,防御):报失败
      if (!appliedCount) {
        return { ok: false, error: failed[0]?.error || i18n.global.t('store.applyYamlFailed') }
      }
      const out = {
        ok: true,
        kind: resource?.kind || object?.kind,
        name: resource?.metadata?.name || object?.metadata?.name,
        namespace: resource?.metadata?.namespace || object?.metadata?.namespace || '',
      }
      // 部分成功:主资源已落,但有资源失败 —— 不阻断成功,以 warning 上报(QA ISSUE-002:旧实现整体报失败且残留资源)
      if (failed.length) {
        out.partial = true
        out.applied = result.applied
        out.failed = failed
        out.warning = failed.map(f => `${f.kind}/${f.name}: ${f.error}`).join('; ')
      }
      return out
    } catch (error) {
      return { ok: false, error: error.message || i18n.global.t('store.applyYamlFailed') }
    }
  }

  return { generateYAML, generateExtraYAML, generateCRYaml, crInstancePath, refreshCRDInstances, applyCRYaml, deleteCRInstance, checkAccessServer, applyResourceYaml }
}
