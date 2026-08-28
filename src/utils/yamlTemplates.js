// 「从 YAML 创建」各 kind 最小模板单源(2026-08-28 全资源 YAML 创建)。
// 约定:键 = K8s kind 名;值为 (ns) => YAML 字符串,纯静态、不依赖 store;
// 集群级 kind(见 CLUSTER_SCOPED_KINDS)的模板不含 metadata.namespace 字段。
// Deployment 迁自 CreateFromYamlDialog 旧内联模板,保留 name: my-app(既有测试断言)。
export const CLUSTER_SCOPED_KINDS = new Set(['ClusterRole', 'ClusterRoleBinding', 'Namespace'])

export const yamlTemplates = {
  Deployment: ns => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
  labels:
    app: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          ports:
            - containerPort: 80
`,
  Service: ns => `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: ${ns}
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
`,
  Ingress: ns => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: ${ns}
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
`,
  PersistentVolumeClaim: ns => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: ${ns}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`,
  HorizontalPodAutoscaler: ns => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-hpa
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
  PodDisruptionBudget: ns => `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-pdb
  namespace: ${ns}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: my-app
`,
  LimitRange: ns => `apiVersion: v1
kind: LimitRange
metadata:
  name: my-limitrange
  namespace: ${ns}
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
`,
  ResourceQuota: ns => `apiVersion: v1
kind: ResourceQuota
metadata:
  name: my-resourcequota
  namespace: ${ns}
spec:
  hard:
    pods: "10"
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.cpu: "2"
    limits.memory: 2Gi
`,
  Role: ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-role
  namespace: ${ns}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
`,
  ClusterRole: () => `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-clusterrole
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
`,
  RoleBinding: ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-rolebinding
  namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: my-role
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: ${ns}
`,
  ClusterRoleBinding: ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-clusterrolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: my-clusterrole
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: ${ns}
`,
  ServiceAccount: ns => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: ${ns}
`,
  Namespace: () => `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
}
