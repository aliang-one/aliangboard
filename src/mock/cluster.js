// ============================================================
// AliangBoard Mock Data — comprehensive per-namespace dataset
// ============================================================

export const clusterInfo = {
  name: 'Production-Cluster-01',
  version: 'k8s v1.28.2',
  apiServer: 'https://api.prod-cluster.kubezen.io:6443',
  status: 'Healthy',
  nodeCount: 8,
  podCount: 247,
  activeEvents: 18,
  cpuUsage: 62,
  cpuTrend: '+4.2%',
  cpuTrendUp: true,
  memoryUsage: 58,
  memoryTrend: '-2.1%',
  memoryTrendUp: false,
}

// ── Namespaces ──────────────────────────────────────────────
export const namespaces = [
  { name: 'default', status: 'Active', pods: 3, services: 2, age: '245d', labels: { 'kubernetes.io/metadata.name': 'default' } },
  { name: 'kube-system', status: 'Active', pods: 12, services: 2, age: '245d', labels: { 'kubernetes.io/metadata.name': 'kube-system' } },
  { name: 'kube-public', status: 'Active', pods: 2, services: 1, age: '245d', labels: { 'kubernetes.io/metadata.name': 'kube-public' } },
  { name: 'kube-node-lease', status: 'Active', pods: 8, services: 0, age: '245d', labels: { 'kubernetes.io/metadata.name': 'kube-node-lease' } },
  { name: 'monitoring', status: 'Active', pods: 12, services: 4, age: '128d', labels: { 'app.kubernetes.io/part-of': 'monitoring-stack' } },
  { name: 'production-apps', status: 'Active', pods: 24, services: 10, age: '98d', labels: { 'environment': 'production' } },
  { name: 'staging', status: 'Active', pods: 6, services: 4, age: '85d', labels: { 'environment': 'staging' } },
  { name: 'logging', status: 'Active', pods: 6, services: 3, age: '67d', labels: { 'app.kubernetes.io/part-of': 'efk-stack' } },
  { name: 'ingress-nginx', status: 'Active', pods: 4, services: 1, age: '200d', labels: { 'app.kubernetes.io/name': 'ingress-nginx' } },
  { name: 'cert-manager', status: 'Active', pods: 3, services: 1, age: '180d', labels: { 'app.kubernetes.io/name': 'cert-manager' } },
]

// ── Nodes ────────────────────────────────────────────────────
export const nodes = [
  { name: 'master-node-01', status: 'Ready', roles: 'master', version: 'v1.28.2', cpu: 18, memory: 32, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.10', age: '245d', conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false, NetworkUnavailable: false } },
  { name: 'worker-node-01', status: 'Ready', roles: 'worker', version: 'v1.28.2', cpu: 45, memory: 58, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.11', age: '245d', pods: 32, conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false } },
  { name: 'worker-node-02', status: 'Ready', roles: 'worker', version: 'v1.28.2', cpu: 62, memory: 71, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.12', age: '245d', pods: 28, conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false } },
  { name: 'worker-node-03', status: 'Ready', roles: 'worker', version: 'v1.28.2', cpu: 38, memory: 45, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.13', age: '180d', pods: 25, conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false } },
  { name: 'worker-node-04', status: 'Ready', roles: 'worker', version: 'v1.28.2', cpu: 78, memory: 82, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.14', age: '180d', pods: 30, conditions: { Ready: true, DiskPressure: true, MemoryPressure: false, PIDPressure: false } },
  { name: 'worker-node-05', status: 'Ready', roles: 'worker', version: 'v1.28.2', cpu: 51, memory: 63, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.15', age: '120d', pods: 27, conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false } },
  { name: 'worker-node-06', status: 'NotReady', roles: 'worker', version: 'v1.28.2', cpu: 0, memory: 0, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.16', age: '120d', pods: 0, conditions: { Ready: false, DiskPressure: false, MemoryPressure: true, PIDPressure: false } },
  { name: 'gpu-node-01', status: 'Ready', roles: 'worker', version: 'v1.28.2', cpu: 34, memory: 52, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.20', age: '90d', pods: 12, conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false } },
]

// ── Workloads ───────────────────────────────────────────────
export const workloads = [
  // production-apps
  { name: 'api-gateway-v2', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '3/3', image: 'kubezen/api-gateway:v2.4.1', sha: 'sha:f82a9d2', age: '45d', labels: { app: 'api-gateway', version: 'v2' } },
  { name: 'frontend-web', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '4/4', image: 'kubezen/frontend:3.1.0', sha: 'sha:b3f98a1', age: '22d', labels: { app: 'frontend-web' } },
  { name: 'order-processor', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '2/2', image: 'kubezen/order-svc:2.8.0', sha: 'sha:7d2e11c', age: '35d', labels: { app: 'order-processor' } },
  { name: 'notification-svc', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '1/1', image: 'kubezen/notify:1.5.2', sha: 'sha:4a8f31d', age: '18d', labels: { app: 'notification-svc' } },
  { name: 'payment-gateway', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '3/3', image: 'kubezen/payment:4.0.1', sha: 'sha:2e7f4cb', age: '15d', labels: { app: 'payment-gateway' } },
  { name: 'user-service', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '2/2', image: 'kubezen/user-svc:1.9.0', sha: 'sha:3b1f8a2', age: '40d', labels: { app: 'user-service' } },
  { name: 'search-engine', type: 'Deployment', namespace: 'production-apps', status: 'Running', replicas: '2/2', image: 'kubezen/search:2.3.1', sha: 'sha:9e4c7d1', age: '28d', labels: { app: 'search-engine' } },
  { name: 'redis-cache-main', type: 'StatefulSet', namespace: 'production-apps', status: 'Pending', replicas: '1/2', image: 'redis:7.2-alpine', sha: 'sha:a921bc1', age: '30d', labels: { app: 'redis-cache' } },
  { name: 'postgres-main', type: 'StatefulSet', namespace: 'production-apps', status: 'Running', replicas: '1/1', image: 'postgres:15.4', sha: 'sha:9c1b22e', age: '98d', labels: { app: 'postgres' } },
  { name: 'rabbitmq-broker', type: 'StatefulSet', namespace: 'production-apps', status: 'Running', replicas: '3/3', image: 'rabbitmq:3.12-management', sha: 'sha:5d3e8f1', age: '60d', labels: { app: 'rabbitmq' } },
  { name: 'search-indexer', type: 'CronJob', schedule: '0 2 * * *', namespace: 'production-apps', status: 'Succeeded', replicas: '0/0', image: 'kubezen/search-index:2.1', sha: 'sha:1a9d4e7', age: '40d', labels: { app: 'search-indexer' } },
  { name: 'db-migrator', type: 'Job', completions: 1, namespace: 'production-apps', status: 'Succeeded', replicas: '0/1', image: 'kubezen/migrate:v5', sha: 'sha:7f2a8c3', age: '3d', labels: { app: 'db-migrator' } },

  // kube-system
  { name: 'coredns', type: 'Deployment', namespace: 'kube-system', status: 'Running', replicas: '2/2', image: 'coredns/coredns:1.11', sha: 'sha:6e2f88a', age: '245d', labels: { 'k8s-app': 'coredns' } },
  { name: 'metrics-server', type: 'Deployment', namespace: 'kube-system', status: 'Running', replicas: '1/1', image: 'metrics-server:v0.7', sha: 'sha:3d7a11b', age: '245d', labels: { 'k8s-app': 'metrics-server' } },
  { name: 'fluentd-logging', type: 'DaemonSet', namespace: 'kube-system', status: 'Running', replicas: '7/7', image: 'fluent/fluentd:v1.16', sha: 'sha:d52c31b', age: '200d', labels: { 'k8s-app': 'fluentd' } },
  { name: 'nvidia-device-plugin', type: 'DaemonSet', namespace: 'kube-system', status: 'Running', replicas: '1/1', image: 'nvidia/k8s-device-plugin:v0.14', sha: 'sha:b2c3d4e', age: '90d', labels: { 'k8s-app': 'nvidia-device-plugin' } },
  { name: 'auth-worker-01', type: 'Deployment', namespace: 'kube-system', status: 'Failed', replicas: '0/1', image: 'kubezen/auth-worker:1.3.0', sha: 'sha:c12d44e', age: '12d', labels: { app: 'auth-worker' } },
  { name: 'kube-proxy', type: 'DaemonSet', namespace: 'kube-system', status: 'Running', replicas: '8/8', image: 'k8s.gcr.io/kube-proxy:v1.28.2', sha: 'sha:e1a2b3c', age: '245d', labels: { 'k8s-app': 'kube-proxy' } },
  { name: 'backup-job', type: 'Job', completions: 1, namespace: 'kube-system', status: 'Running', replicas: '1/1', image: 'kubezen/backup:v3', sha: 'sha:5c8b2f3', age: '2h', labels: { app: 'backup' } },

  // monitoring
  { name: 'prometheus-server', type: 'Deployment', namespace: 'monitoring', status: 'Running', replicas: '1/1', image: 'prom/prometheus:v2.48.0', sha: 'sha:e22b10a', age: '128d', labels: { app: 'prometheus' } },
  { name: 'grafana-dashboard', type: 'Deployment', namespace: 'monitoring', status: 'Running', replicas: '1/1', image: 'grafana/grafana:10.2', sha: 'sha:f1d33b2', age: '128d', labels: { app: 'grafana' } },
  { name: 'kube-state-metrics', type: 'Deployment', namespace: 'monitoring', status: 'Running', replicas: '1/1', image: 'kube-state-metrics:v2.12', sha: 'sha:9f1c2d3', age: '128d', labels: { app: 'kube-state-metrics' } },
  { name: 'alertmanager', type: 'Deployment', namespace: 'monitoring', status: 'Running', replicas: '2/2', image: 'prom/alertmanager:v0.26', sha: 'sha:4b5c6d7', age: '128d', labels: { app: 'alertmanager' } },
  { name: 'node-exporter', type: 'DaemonSet', namespace: 'monitoring', status: 'Running', replicas: '7/7', image: 'prom/node-exporter:v1.7', sha: 'sha:8e9f0a1', age: '128d', labels: { app: 'node-exporter' } },

  // logging
  { name: 'elasticsearch', type: 'StatefulSet', namespace: 'logging', status: 'Running', replicas: '3/3', image: 'elastic/elasticsearch:8.11', sha: 'sha:a2c44f8', age: '67d', labels: { app: 'elasticsearch' } },
  { name: 'kibana-visual', type: 'Deployment', namespace: 'logging', status: 'Pending', replicas: '0/1', image: 'elastic/kibana:8.11', sha: 'sha:e5d77a3', age: '67d', labels: { app: 'kibana' } },
  { name: 'logstash-pipeline', type: 'Deployment', namespace: 'logging', status: 'Running', replicas: '2/2', image: 'elastic/logstash:8.11', sha: 'sha:c3d4e5f', age: '60d', labels: { app: 'logstash' } },

  // ingress-nginx
  { name: 'ingress-nginx-controller', type: 'Deployment', namespace: 'ingress-nginx', status: 'Running', replicas: '2/2', image: 'ingress-nginx/controller:v1.9', sha: 'sha:c4a11b5', age: '200d', labels: { app: 'ingress-nginx' } },
  { name: 'ingress-nginx-defaultbackend', type: 'Deployment', namespace: 'ingress-nginx', status: 'Running', replicas: '1/1', image: 'k8s.gcr.io/defaultbackend:1.5', sha: 'sha:d1e2f3a', age: '200d', labels: { app: 'defaultbackend' } },

  // cert-manager
  { name: 'cert-manager-controller', type: 'Deployment', namespace: 'cert-manager', status: 'Running', replicas: '1/1', image: 'cert-manager/controller:v1.13', sha: 'sha:d6f22c1', age: '180d', labels: { app: 'cert-manager' } },
  { name: 'cert-manager-webhook', type: 'Deployment', namespace: 'cert-manager', status: 'Running', replicas: '1/1', image: 'cert-manager/webhook:v1.13', sha: 'sha:e7a3b2c', age: '180d', labels: { app: 'cert-manager-webhook' } },
  { name: 'cert-manager-cainjector', type: 'Deployment', namespace: 'cert-manager', status: 'Running', replicas: '1/1', image: 'cert-manager/cainjector:v1.13', sha: 'sha:f8b4c3d', age: '180d', labels: { app: 'cert-manager-cainjector' } },

  // staging
  { name: 'user-service-staging', type: 'Deployment', namespace: 'staging', status: 'Running', replicas: '1/1', image: 'kubezen/user-svc:dev-42', sha: 'sha:8b3a19d', age: '5d', labels: { app: 'user-service', env: 'staging' } },
  { name: 'payment-staging', type: 'Deployment', namespace: 'staging', status: 'Running', replicas: '1/1', image: 'kubezen/payment:dev-18', sha: 'sha:a4c2b1e', age: '3d', labels: { app: 'payment', env: 'staging' } },
  { name: 'frontend-staging', type: 'Deployment', namespace: 'staging', status: 'Running', replicas: '2/2', image: 'kubezen/frontend:dev-67', sha: 'sha:b5d3c2f', age: '1d', labels: { app: 'frontend', env: 'staging' } },
  { name: 'api-gateway-staging', type: 'Deployment', namespace: 'staging', status: 'Running', replicas: '1/1', image: 'kubezen/api-gateway:dev-33', sha: 'sha:c6e4d3a', age: '7d', labels: { app: 'api-gateway', env: 'staging' } },
  { name: 'db-migrate-staging', type: 'Job', namespace: 'staging', status: 'Succeeded', replicas: '0/1', image: 'kubezen/migrate:dev-5', sha: 'sha:d7f5e4b', age: '2d', labels: { app: 'db-migrate', env: 'staging' } },

  // default
  { name: 'nginx-demo', type: 'Deployment', namespace: 'default', status: 'Running', replicas: '2/2', image: 'nginx:1.25', sha: 'sha:1a2b3c4', age: '30d', labels: { app: 'nginx-demo' } },
  { name: 'hello-app', type: 'Deployment', namespace: 'default', status: 'Running', replicas: '1/1', image: 'gcr.io/google-samples/hello-app:1.0', sha: 'sha:5e6f7a8', age: '15d', labels: { app: 'hello-app' } },
]

// ── Pods ─────────────────────────────────────────────────────
export const pods = [
  // production-apps
  { name: 'api-gateway-v2-6b7c8-abc12', namespace: 'production-apps', status: 'Running', node: 'worker-node-01', ip: '10.42.1.15', cpu: '124m/500m', memory: '182Mi/512Mi', restarts: 2, age: '12d', containers: ['api-gateway'], image: 'kubezen/api-gateway:v2.4.1', labels: { app: 'api-gateway', version: 'v2', 'pod-template-hash': '6b7c8' }, annotations: { 'deployment.kubernetes.io/revision': '4' } },
  { name: 'api-gateway-v2-6b7c8-def34', namespace: 'production-apps', status: 'Running', node: 'worker-node-02', ip: '10.42.2.22', cpu: '256m/1000m', memory: '384Mi/1Gi', restarts: 0, age: '12d', containers: ['api-gateway'], image: 'kubezen/api-gateway:v2.4.1', labels: { app: 'api-gateway', version: 'v2', 'pod-template-hash': '6b7c8' }, annotations: {} },
  { name: 'api-gateway-v2-6b7c8-ghi56', namespace: 'production-apps', status: 'Running', node: 'worker-node-03', ip: '10.42.3.33', cpu: '98m/500m', memory: '156Mi/512Mi', restarts: 0, age: '12d', containers: ['api-gateway'], image: 'kubezen/api-gateway:v2.4.1', labels: { app: 'api-gateway', version: 'v2', 'pod-template-hash': '6b7c8' }, annotations: {} },
  { name: 'frontend-web-8f9a2-x1', namespace: 'production-apps', status: 'Running', node: 'worker-node-01', ip: '10.42.1.20', cpu: '80m/250m', memory: '128Mi/256Mi', restarts: 0, age: '22d', containers: ['frontend'], image: 'kubezen/frontend:3.1.0', labels: { app: 'frontend-web', tier: 'frontend' }, annotations: {} },
  { name: 'frontend-web-8f9a2-x2', namespace: 'production-apps', status: 'Running', node: 'worker-node-02', ip: '10.42.2.24', cpu: '92m/250m', memory: '140Mi/256Mi', restarts: 0, age: '22d', containers: ['frontend'], image: 'kubezen/frontend:3.1.0', labels: { app: 'frontend-web', tier: 'frontend' }, annotations: {} },
  { name: 'frontend-web-8f9a2-x3', namespace: 'production-apps', status: 'Running', node: 'worker-node-03', ip: '10.42.3.26', cpu: '76m/250m', memory: '118Mi/256Mi', restarts: 1, age: '22d', containers: ['frontend'], image: 'kubezen/frontend:3.1.0', labels: { app: 'frontend-web', tier: 'frontend' }, annotations: {} },
  { name: 'frontend-web-8f9a2-x4', namespace: 'production-apps', status: 'Running', node: 'worker-node-05', ip: '10.42.5.30', cpu: '65m/250m', memory: '105Mi/256Mi', restarts: 0, age: '22d', containers: ['frontend'], image: 'kubezen/frontend:3.1.0', labels: { app: 'frontend-web', tier: 'frontend' }, annotations: {} },
  { name: 'order-processor-c4d5-k1', namespace: 'production-apps', status: 'Running', node: 'worker-node-01', ip: '10.42.1.35', cpu: '200m/500m', memory: '256Mi/512Mi', restarts: 0, age: '35d', containers: ['order-svc'], image: 'kubezen/order-svc:2.8.0', labels: { app: 'order-processor' }, annotations: {} },
  { name: 'order-processor-c4d5-k2', namespace: 'production-apps', status: 'Running', node: 'worker-node-04', ip: '10.42.4.36', cpu: '180m/500m', memory: '240Mi/512Mi', restarts: 3, age: '35d', containers: ['order-svc'], image: 'kubezen/order-svc:2.8.0', labels: { app: 'order-processor' }, annotations: {} },
  { name: 'notification-svc-a1b2-p1', namespace: 'production-apps', status: 'Running', node: 'worker-node-02', ip: '10.42.2.40', cpu: '50m/250m', memory: '80Mi/256Mi', restarts: 0, age: '18d', containers: ['notify'], image: 'kubezen/notify:1.5.2', labels: { app: 'notification-svc' }, annotations: {} },
  { name: 'payment-gateway-f7g8-r1', namespace: 'production-apps', status: 'Running', node: 'worker-node-03', ip: '10.42.3.45', cpu: '310m/1000m', memory: '420Mi/1Gi', restarts: 0, age: '15d', containers: ['payment'], image: 'kubezen/payment:4.0.1', labels: { app: 'payment-gateway' }, annotations: {} },
  { name: 'payment-gateway-f7g8-r2', namespace: 'production-apps', status: 'Running', node: 'worker-node-05', ip: '10.42.5.46', cpu: '280m/1000m', memory: '380Mi/1Gi', restarts: 0, age: '15d', containers: ['payment'], image: 'kubezen/payment:4.0.1', labels: { app: 'payment-gateway' }, annotations: {} },
  { name: 'payment-gateway-f7g8-r3', namespace: 'production-apps', status: 'Running', node: 'worker-node-01', ip: '10.42.1.47', cpu: '295m/1000m', memory: '410Mi/1Gi', restarts: 1, age: '15d', containers: ['payment'], image: 'kubezen/payment:4.0.1', labels: { app: 'payment-gateway' }, annotations: {} },
  { name: 'user-service-e3f4-s1', namespace: 'production-apps', status: 'Running', node: 'worker-node-02', ip: '10.42.2.50', cpu: '120m/500m', memory: '200Mi/512Mi', restarts: 0, age: '40d', containers: ['user-svc'], image: 'kubezen/user-svc:1.9.0', labels: { app: 'user-service' }, annotations: {} },
  { name: 'user-service-e3f4-s2', namespace: 'production-apps', status: 'Running', node: 'worker-node-04', ip: '10.42.4.51', cpu: '135m/500m', memory: '210Mi/512Mi', restarts: 0, age: '40d', containers: ['user-svc'], image: 'kubezen/user-svc:1.9.0', labels: { app: 'user-service' }, annotations: {} },
  { name: 'search-engine-h5i6-t1', namespace: 'production-apps', status: 'Running', node: 'worker-node-05', ip: '10.42.5.55', cpu: '400m/2000m', memory: '1.2Gi/4Gi', restarts: 0, age: '28d', containers: ['search'], image: 'kubezen/search:2.3.1', labels: { app: 'search-engine' }, annotations: {} },
  { name: 'search-engine-h5i6-t2', namespace: 'production-apps', status: 'Running', node: 'worker-node-03', ip: '10.42.3.56', cpu: '350m/2000m', memory: '980Mi/4Gi', restarts: 1, age: '28d', containers: ['search'], image: 'kubezen/search:2.3.1', labels: { app: 'search-engine' }, annotations: {} },
  { name: 'redis-cache-main-0', namespace: 'production-apps', status: 'Running', node: 'worker-node-04', ip: '10.42.4.60', cpu: '60m/500m', memory: '256Mi/1Gi', restarts: 0, age: '30d', containers: ['redis'], image: 'redis:7.2-alpine', labels: { app: 'redis-cache' }, annotations: {} },
  { name: 'redis-cache-main-1', namespace: 'production-apps', status: 'Pending', node: '', ip: '', cpu: '0/0', memory: '0/0', restarts: 0, age: '5m', containers: ['redis'], image: 'redis:7.2-alpine', labels: { app: 'redis-cache' }, annotations: {} },
  { name: 'postgres-main-0', namespace: 'production-apps', status: 'Running', node: 'worker-node-05', ip: '10.42.5.65', cpu: '180m/1000m', memory: '512Mi/2Gi', restarts: 0, age: '98d', containers: ['postgres'], image: 'postgres:15.4', labels: { app: 'postgres' }, annotations: {} },
  { name: 'rabbitmq-broker-0', namespace: 'production-apps', status: 'Running', node: 'worker-node-01', ip: '10.42.1.70', cpu: '90m/500m', memory: '320Mi/1Gi', restarts: 0, age: '60d', containers: ['rabbitmq'], image: 'rabbitmq:3.12-management', labels: { app: 'rabbitmq' }, annotations: {} },
  { name: 'rabbitmq-broker-1', namespace: 'production-apps', status: 'Running', node: 'worker-node-02', ip: '10.42.2.71', cpu: '85m/500m', memory: '310Mi/1Gi', restarts: 0, age: '60d', containers: ['rabbitmq'], image: 'rabbitmq:3.12-management', labels: { app: 'rabbitmq' }, annotations: {} },
  { name: 'rabbitmq-broker-2', namespace: 'production-apps', status: 'Running', node: 'worker-node-03', ip: '10.42.3.72', cpu: '88m/500m', memory: '305Mi/1Gi', restarts: 0, age: '60d', containers: ['rabbitmq'], image: 'rabbitmq:3.12-management', labels: { app: 'rabbitmq' }, annotations: {} },
  { name: 'db-migrator-k8x-complete', namespace: 'production-apps', status: 'Succeeded', node: 'worker-node-04', ip: '10.42.4.80', cpu: '0/500m', memory: '0/256Mi', restarts: 0, age: '3d', containers: ['migrate'], image: 'kubezen/migrate:v5', labels: { app: 'db-migrator' }, annotations: {} },

  // kube-system
  { name: 'coredns-6d4b5c-abc12', namespace: 'kube-system', status: 'Running', node: 'master-node-01', ip: '10.42.0.2', cpu: '20m/250m', memory: '40Mi/128Mi', restarts: 0, age: '245d', containers: ['coredns'], image: 'coredns/coredns:1.11', labels: { 'k8s-app': 'coredns' }, annotations: {} },
  { name: 'coredns-6d4b5c-def34', namespace: 'kube-system', status: 'Running', node: 'master-node-01', ip: '10.42.0.3', cpu: '18m/250m', memory: '35Mi/128Mi', restarts: 0, age: '245d', containers: ['coredns'], image: 'coredns/coredns:1.11', labels: { 'k8s-app': 'coredns' }, annotations: {} },
  { name: 'metrics-server-7f8a9-p1', namespace: 'kube-system', status: 'Running', node: 'master-node-01', ip: '10.42.0.5', cpu: '30m/250m', memory: '60Mi/256Mi', restarts: 0, age: '245d', containers: ['metrics-server'], image: 'metrics-server:v0.7', labels: { 'k8s-app': 'metrics-server' }, annotations: {} },
  { name: 'fluentd-logging-abc12', namespace: 'kube-system', status: 'Running', node: 'worker-node-01', ip: '10.42.1.5', cpu: '40m/250m', memory: '80Mi/256Mi', restarts: 0, age: '200d', containers: ['fluentd'], image: 'fluent/fluentd:v1.16', labels: { 'k8s-app': 'fluentd' }, annotations: {} },
  { name: 'fluentd-logging-def34', namespace: 'kube-system', status: 'Running', node: 'worker-node-02', ip: '10.42.2.5', cpu: '38m/250m', memory: '75Mi/256Mi', restarts: 0, age: '200d', containers: ['fluentd'], image: 'fluent/fluentd:v1.16', labels: { 'k8s-app': 'fluentd' }, annotations: {} },
  { name: 'fluentd-logging-ghi56', namespace: 'kube-system', status: 'Running', node: 'worker-node-03', ip: '10.42.3.5', cpu: '35m/250m', memory: '72Mi/256Mi', restarts: 0, age: '200d', containers: ['fluentd'], image: 'fluent/fluentd:v1.16', labels: { 'k8s-app': 'fluentd' }, annotations: {} },
  { name: 'auth-worker-01-9d4e2', namespace: 'kube-system', status: 'Failed', node: 'worker-node-03', ip: '10.42.3.88', cpu: '0/500m', memory: '0/512Mi', restarts: 5, age: '1d', containers: ['auth-worker'], image: 'kubezen/auth-worker:1.3.0', labels: { app: 'auth-worker' }, annotations: {} },
  { name: 'kube-proxy-worker01', namespace: 'kube-system', status: 'Running', node: 'worker-node-01', ip: '10.42.1.2', cpu: '15m/250m', memory: '32Mi/128Mi', restarts: 0, age: '245d', containers: ['kube-proxy'], image: 'k8s.gcr.io/kube-proxy:v1.28.2', labels: { 'k8s-app': 'kube-proxy' }, annotations: {} },
  { name: 'kube-proxy-worker02', namespace: 'kube-system', status: 'Running', node: 'worker-node-02', ip: '10.42.2.2', cpu: '12m/250m', memory: '28Mi/128Mi', restarts: 0, age: '245d', containers: ['kube-proxy'], image: 'k8s.gcr.io/kube-proxy:v1.28.2', labels: { 'k8s-app': 'kube-proxy' }, annotations: {} },
  { name: 'backup-job-20240612', namespace: 'kube-system', status: 'Running', node: 'worker-node-04', ip: '10.42.4.90', cpu: '200m/500m', memory: '256Mi/512Mi', restarts: 0, age: '2h', containers: ['backup'], image: 'kubezen/backup:v3', labels: { app: 'backup' }, annotations: {} },
  { name: 'nvidia-plugin-gpu01', namespace: 'kube-system', status: 'Running', node: 'gpu-node-01', ip: '10.42.6.2', cpu: '10m/250m', memory: '20Mi/128Mi', restarts: 0, age: '90d', containers: ['nvidia-device-plugin'], image: 'nvidia/k8s-device-plugin:v0.14', labels: { 'k8s-app': 'nvidia-device-plugin' }, annotations: {} },

  // monitoring
  { name: 'prometheus-server-f7a1', namespace: 'monitoring', status: 'Running', node: 'worker-node-05', ip: '10.42.5.10', cpu: '340m/2000m', memory: '1.2Gi/4Gi', restarts: 1, age: '128d', containers: ['prometheus'], image: 'prom/prometheus:v2.48.0', labels: { app: 'prometheus' }, annotations: { 'prometheus.io/scrape': 'true' } },
  { name: 'grafana-dashboard-b2c3', namespace: 'monitoring', status: 'Running', node: 'worker-node-01', ip: '10.42.1.12', cpu: '45m/250m', memory: '90Mi/256Mi', restarts: 0, age: '128d', containers: ['grafana'], image: 'grafana/grafana:10.2', labels: { app: 'grafana' }, annotations: {} },
  { name: 'kube-state-metrics-d4e5', namespace: 'monitoring', status: 'Running', node: 'worker-node-02', ip: '10.42.2.14', cpu: '25m/250m', memory: '50Mi/128Mi', restarts: 0, age: '128d', containers: ['kube-state-metrics'], image: 'kube-state-metrics:v2.12', labels: { app: 'kube-state-metrics' }, annotations: {} },
  { name: 'alertmanager-f6g7-1', namespace: 'monitoring', status: 'Running', node: 'worker-node-03', ip: '10.42.3.16', cpu: '20m/250m', memory: '45Mi/128Mi', restarts: 0, age: '128d', containers: ['alertmanager'], image: 'prom/alertmanager:v0.26', labels: { app: 'alertmanager' }, annotations: {} },
  { name: 'alertmanager-f6g7-2', namespace: 'monitoring', status: 'Running', node: 'worker-node-04', ip: '10.42.4.17', cpu: '18m/250m', memory: '40Mi/128Mi', restarts: 0, age: '128d', containers: ['alertmanager'], image: 'prom/alertmanager:v0.26', labels: { app: 'alertmanager' }, annotations: {} },
  { name: 'node-exporter-h8i9-1', namespace: 'monitoring', status: 'Running', node: 'worker-node-01', ip: '10.42.1.18', cpu: '8m/100m', memory: '20Mi/64Mi', restarts: 0, age: '128d', containers: ['node-exporter'], image: 'prom/node-exporter:v1.7', labels: { app: 'node-exporter' }, annotations: {} },
  { name: 'node-exporter-h8i9-2', namespace: 'monitoring', status: 'Running', node: 'worker-node-02', ip: '10.42.2.18', cpu: '7m/100m', memory: '18Mi/64Mi', restarts: 0, age: '128d', containers: ['node-exporter'], image: 'prom/node-exporter:v1.7', labels: { app: 'node-exporter' }, annotations: {} },
  { name: 'node-exporter-h8i9-3', namespace: 'monitoring', status: 'Running', node: 'worker-node-03', ip: '10.42.3.18', cpu: '9m/100m', memory: '22Mi/64Mi', restarts: 0, age: '128d', containers: ['node-exporter'], image: 'prom/node-exporter:v1.7', labels: { app: 'node-exporter' }, annotations: {} },
  { name: 'node-exporter-h8i9-4', namespace: 'monitoring', status: 'Running', node: 'worker-node-04', ip: '10.42.4.18', cpu: '6m/100m', memory: '16Mi/64Mi', restarts: 0, age: '128d', containers: ['node-exporter'], image: 'prom/node-exporter:v1.7', labels: { app: 'node-exporter' }, annotations: {} },
  { name: 'node-exporter-h8i9-5', namespace: 'monitoring', status: 'Running', node: 'worker-node-05', ip: '10.42.5.18', cpu: '8m/100m', memory: '19Mi/64Mi', restarts: 0, age: '128d', containers: ['node-exporter'], image: 'prom/node-exporter:v1.7', labels: { app: 'node-exporter' }, annotations: {} },

  // logging
  { name: 'elasticsearch-0', namespace: 'logging', status: 'Running', node: 'worker-node-01', ip: '10.42.1.100', cpu: '500m/2000m', memory: '2Gi/4Gi', restarts: 0, age: '67d', containers: ['elasticsearch'], image: 'elastic/elasticsearch:8.11', labels: { app: 'elasticsearch' }, annotations: {} },
  { name: 'elasticsearch-1', namespace: 'logging', status: 'Running', node: 'worker-node-02', ip: '10.42.2.100', cpu: '480m/2000m', memory: '1.8Gi/4Gi', restarts: 0, age: '67d', containers: ['elasticsearch'], image: 'elastic/elasticsearch:8.11', labels: { app: 'elasticsearch' }, annotations: {} },
  { name: 'elasticsearch-2', namespace: 'logging', status: 'Running', node: 'worker-node-03', ip: '10.42.3.100', cpu: '520m/2000m', memory: '2.1Gi/4Gi', restarts: 1, age: '67d', containers: ['elasticsearch'], image: 'elastic/elasticsearch:8.11', labels: { app: 'elasticsearch' }, annotations: {} },
  { name: 'kibana-visual-5d6e-1', namespace: 'logging', status: 'Pending', node: '', ip: '', cpu: '0/0', memory: '0/0', restarts: 0, age: '5m', containers: ['kibana'], image: 'elastic/kibana:8.11', labels: { app: 'kibana' }, annotations: {} },
  { name: 'logstash-pipeline-a1b2-1', namespace: 'logging', status: 'Running', node: 'worker-node-04', ip: '10.42.4.105', cpu: '200m/1000m', memory: '512Mi/1Gi', restarts: 0, age: '60d', containers: ['logstash'], image: 'elastic/logstash:8.11', labels: { app: 'logstash' }, annotations: {} },
  { name: 'logstash-pipeline-a1b2-2', namespace: 'logging', status: 'Running', node: 'worker-node-05', ip: '10.42.5.106', cpu: '180m/1000m', memory: '480Mi/1Gi', restarts: 0, age: '60d', containers: ['logstash'], image: 'elastic/logstash:8.11', labels: { app: 'logstash' }, annotations: {} },

  // ingress-nginx
  { name: 'ingress-nginx-controller-7a8b-1', namespace: 'ingress-nginx', status: 'Running', node: 'worker-node-01', ip: '10.42.1.110', cpu: '60m/500m', memory: '180Mi/512Mi', restarts: 0, age: '200d', containers: ['controller'], image: 'ingress-nginx/controller:v1.9', labels: { app: 'ingress-nginx' }, annotations: {} },
  { name: 'ingress-nginx-controller-7a8b-2', namespace: 'ingress-nginx', status: 'Running', node: 'worker-node-02', ip: '10.42.2.110', cpu: '55m/500m', memory: '170Mi/512Mi', restarts: 0, age: '200d', containers: ['controller'], image: 'ingress-nginx/controller:v1.9', labels: { app: 'ingress-nginx' }, annotations: {} },
  { name: 'ingress-defaultbackend-c3d4', namespace: 'ingress-nginx', status: 'Running', node: 'worker-node-03', ip: '10.42.3.112', cpu: '5m/100m', memory: '12Mi/64Mi', restarts: 0, age: '200d', containers: ['defaultbackend'], image: 'k8s.gcr.io/defaultbackend:1.5', labels: { app: 'defaultbackend' }, annotations: {} },
  { name: 'ingress-nginx-admission-e5f6', namespace: 'ingress-nginx', status: 'Completed', node: 'master-node-01', ip: '10.42.0.115', cpu: '0/250m', memory: '0/128Mi', restarts: 0, age: '200d', containers: ['create-admission'], image: 'ingress-nginx/kube-webhook-certgen:v20231011', labels: { app: 'ingress-nginx' }, annotations: {} },

  // cert-manager
  { name: 'cert-manager-controller-8a9b', namespace: 'cert-manager', status: 'Running', node: 'worker-node-04', ip: '10.42.4.120', cpu: '35m/250m', memory: '80Mi/256Mi', restarts: 0, age: '180d', containers: ['controller'], image: 'cert-manager/controller:v1.13', labels: { app: 'cert-manager' }, annotations: {} },
  { name: 'cert-manager-webhook-c1d2', namespace: 'cert-manager', status: 'Running', node: 'worker-node-05', ip: '10.42.5.122', cpu: '10m/250m', memory: '25Mi/128Mi', restarts: 0, age: '180d', containers: ['webhook'], image: 'cert-manager/webhook:v1.13', labels: { app: 'cert-manager-webhook' }, annotations: {} },
  { name: 'cert-manager-cainjector-e3f4', namespace: 'cert-manager', status: 'Running', node: 'worker-node-03', ip: '10.42.3.124', cpu: '12m/250m', memory: '30Mi/128Mi', restarts: 0, age: '180d', containers: ['cainjector'], image: 'cert-manager/cainjector:v1.13', labels: { app: 'cert-manager-cainjector' }, annotations: {} },

  // staging
  { name: 'user-service-staging-a1b2', namespace: 'staging', status: 'Running', node: 'worker-node-04', ip: '10.42.4.130', cpu: '80m/500m', memory: '128Mi/512Mi', restarts: 2, age: '5d', containers: ['user-svc'], image: 'kubezen/user-svc:dev-42', labels: { app: 'user-service', env: 'staging' }, annotations: {} },
  { name: 'payment-staging-c3d4', namespace: 'staging', status: 'Running', node: 'worker-node-05', ip: '10.42.5.132', cpu: '70m/500m', memory: '110Mi/512Mi', restarts: 0, age: '3d', containers: ['payment'], image: 'kubezen/payment:dev-18', labels: { app: 'payment', env: 'staging' }, annotations: {} },
  { name: 'frontend-staging-e5f6-1', namespace: 'staging', status: 'Running', node: 'worker-node-03', ip: '10.42.3.134', cpu: '50m/250m', memory: '80Mi/256Mi', restarts: 0, age: '1d', containers: ['frontend'], image: 'kubezen/frontend:dev-67', labels: { app: 'frontend', env: 'staging' }, annotations: {} },
  { name: 'frontend-staging-e5f6-2', namespace: 'staging', status: 'Running', node: 'worker-node-04', ip: '10.42.4.135', cpu: '45m/250m', memory: '75Mi/256Mi', restarts: 0, age: '1d', containers: ['frontend'], image: 'kubezen/frontend:dev-67', labels: { app: 'frontend', env: 'staging' }, annotations: {} },
  { name: 'api-gateway-staging-g7h8', namespace: 'staging', status: 'Running', node: 'worker-node-05', ip: '10.42.5.136', cpu: '60m/500m', memory: '95Mi/512Mi', restarts: 1, age: '7d', containers: ['api-gateway'], image: 'kubezen/api-gateway:dev-33', labels: { app: 'api-gateway', env: 'staging' }, annotations: {} },
  { name: 'db-migrate-staging-i9j0', namespace: 'staging', status: 'Succeeded', node: 'worker-node-03', ip: '10.42.3.138', cpu: '0/500m', memory: '0/256Mi', restarts: 0, age: '2d', containers: ['migrate'], image: 'kubezen/migrate:dev-5', labels: { app: 'db-migrate', env: 'staging' }, annotations: {} },

  // default
  { name: 'nginx-demo-5f6a-1', namespace: 'default', status: 'Running', node: 'worker-node-01', ip: '10.42.1.140', cpu: '10m/250m', memory: '20Mi/128Mi', restarts: 0, age: '30d', containers: ['nginx'], image: 'nginx:1.25', labels: { app: 'nginx-demo' }, annotations: {} },
  { name: 'nginx-demo-5f6a-2', namespace: 'default', status: 'Running', node: 'worker-node-02', ip: '10.42.2.141', cpu: '8m/250m', memory: '18Mi/128Mi', restarts: 0, age: '30d', containers: ['nginx'], image: 'nginx:1.25', labels: { app: 'nginx-demo' }, annotations: {} },
  { name: 'hello-app-7b8c', namespace: 'default', status: 'Running', node: 'worker-node-03', ip: '10.42.3.142', cpu: '5m/100m', memory: '10Mi/64Mi', restarts: 0, age: '15d', containers: ['hello-app'], image: 'gcr.io/google-samples/hello-app:1.0', labels: { app: 'hello-app' }, annotations: {} },
  { name: 'kube-public-cm-sync', namespace: 'kube-public', status: 'Running', node: 'master-node-01', ip: '10.42.0.150', cpu: '5m/100m', memory: '12Mi/64Mi', restarts: 0, age: '120d', containers: ['sync'], image: 'k8s.gcr.io/configmap-sync:v1', labels: { app: 'cm-sync' }, annotations: {} },
  { name: 'kube-public-info-svc', namespace: 'kube-public', status: 'Running', node: 'master-node-01', ip: '10.42.0.151', cpu: '3m/100m', memory: '8Mi/64Mi', restarts: 0, age: '120d', containers: ['info-svc'], image: 'k8s.gcr.io/info-service:v1', labels: { app: 'info-svc' }, annotations: {} },

  // kube-node-lease
  { name: 'lease-agent-master01', namespace: 'kube-node-lease', status: 'Running', node: 'master-node-01', ip: '10.42.0.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '245d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-worker01', namespace: 'kube-node-lease', status: 'Running', node: 'worker-node-01', ip: '10.42.1.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '245d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-worker02', namespace: 'kube-node-lease', status: 'Running', node: 'worker-node-02', ip: '10.42.2.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '245d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-worker03', namespace: 'kube-node-lease', status: 'Running', node: 'worker-node-03', ip: '10.42.3.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '245d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-worker04', namespace: 'kube-node-lease', status: 'Running', node: 'worker-node-04', ip: '10.42.4.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '245d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-worker05', namespace: 'kube-node-lease', status: 'Running', node: 'worker-node-05', ip: '10.42.5.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '245d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-gpu01', namespace: 'kube-node-lease', status: 'Running', node: 'gpu-node-01', ip: '10.42.6.160', cpu: '2m/50m', memory: '8Mi/32Mi', restarts: 0, age: '90d', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
  { name: 'lease-agent-worker06', namespace: 'kube-node-lease', status: 'Failed', node: 'worker-node-06', ip: '', cpu: '0/0', memory: '0/0', restarts: 3, age: '1h', containers: ['lease-agent'], image: 'k8s.gcr.io/lease-agent:v1', labels: { 'k8s-app': 'lease-agent' }, annotations: {} },
]

// ── Pod Logs ────────────────────────────────────────────────
export const podLogs = [
  { timestamp: '2024-06-12T14:22:01.002Z', level: 'INFO', message: 'Initializing service connection pool...' },
  { timestamp: '2024-06-12T14:22:01.450Z', level: 'INFO', message: 'Database connected: postgres://db-master:5432' },
  { timestamp: '2024-06-12T14:22:02.122Z', level: 'INFO', message: 'Server listening on port 8080' },
  { timestamp: '2024-06-12T14:23:45.981Z', level: 'INFO', message: 'GET /api/v1/health - 200 OK (12ms)' },
  { timestamp: '2024-06-12T14:24:12.441Z', level: 'INFO', message: 'GET /api/v1/metrics - 200 OK (45ms)' },
  { timestamp: '2024-06-12T14:25:30.003Z', level: 'WARN', message: 'Slow query detected on /api/v1/products/search (240ms)' },
  { timestamp: '2024-06-12T14:26:01.229Z', level: 'INFO', message: 'GET /api/v1/health - 200 OK (8ms)' },
  { timestamp: '2024-06-12T14:27:15.882Z', level: 'INFO', message: 'POST /api/v1/orders - 201 Created (156ms)' },
  { timestamp: '2024-06-12T14:28:44.301Z', level: 'ERROR', message: 'Connection reset by peer: 10.42.1.192' },
  { timestamp: '2024-06-12T14:28:44.310Z', level: 'INFO', message: 'Retrying connection in 500ms...' },
  { timestamp: '2024-06-12T14:28:44.815Z', level: 'INFO', message: 'Connection re-established successfully' },
  { timestamp: '2024-06-12T14:29:10.000Z', level: 'INFO', message: 'GET /api/v1/health - 200 OK (5ms)' },
  { timestamp: '2024-06-12T14:30:22.110Z', level: 'INFO', message: 'GET /api/v1/users - 200 OK (22ms)' },
  { timestamp: '2024-06-12T14:31:05.445Z', level: 'INFO', message: 'POST /api/v1/auth/login - 200 OK (89ms)' },
  { timestamp: '2024-06-12T14:32:18.772Z', level: 'WARN', message: 'Rate limit approaching for IP 10.42.2.100' },
  { timestamp: '2024-06-12T14:33:01.003Z', level: 'INFO', message: 'GET /api/v1/products - 200 OK (34ms)' },
  { timestamp: '2024-06-12T14:34:12.556Z', level: 'INFO', message: 'WS connection established: client-abc123' },
  { timestamp: '2024-06-12T14:35:45.220Z', level: 'INFO', message: 'Cache hit ratio: 94.2% (5120/5431)' },
  { timestamp: '2024-06-12T14:36:30.112Z', level: 'WARN', message: 'Memory usage at 78% - monitoring closely' },
  { timestamp: '2024-06-12T14:37:15.887Z', level: 'INFO', message: 'Scheduled task completed: cleanup-expired-sessions' },
]

// ── Events (per-namespace aware) ─────────────────────────────
export const events = [
  { type: 'normal', reason: 'ReplicaSet scaled up', message: 'Deployment frontend-app scaled from 3 to 5 replicas.', time: '2m ago', icon: 'verified', color: 'primary', namespace: 'production-apps' },
  { type: 'warning', reason: 'Node pressure detected', message: 'worker-node-04 reporting high disk I/O wait times.', time: '15m ago', icon: 'warning', color: 'tertiary', namespace: 'kube-system' },
  { type: 'normal', reason: 'New Ingress created', message: 'Host api.kubezen.io mapped to backend-svc.', time: '42m ago', icon: 'add_task', color: 'primary', namespace: 'production-apps' },
  { type: 'normal', reason: 'Configuration updated', message: 'ConfigMap app-env-vars updated in production-apps namespace.', time: '1h ago', icon: 'update', color: 'surface', namespace: 'production-apps' },
  { type: 'normal', reason: 'Pod scheduled', message: 'Pod payment-gateway-7a8b deployed on worker-node-02.', time: '1.5h ago', icon: 'check_circle', color: 'primary', namespace: 'production-apps' },
  { type: 'warning', reason: 'ImagePullBackOff', message: 'Failed to pull image kubezen/auth-worker:1.3.0 from registry.', time: '2h ago', icon: 'error', color: 'error', namespace: 'kube-system' },
  { type: 'normal', reason: 'HorizontalPodAutoscaler', message: 'Deployment api-gateway scaled up to 4 replicas.', time: '3h ago', icon: 'timeline', color: 'primary', namespace: 'production-apps' },
  { type: 'normal', reason: 'Secret updated', message: 'TLS certificate renewed for ingress api.kubezen.io.', time: '4h ago', icon: 'lock', color: 'primary', namespace: 'production-apps' },
  { type: 'normal', reason: 'Pod started', message: 'prometheus-server-f7a1 now running on worker-node-05.', time: '10m ago', icon: 'play_circle', color: 'primary', namespace: 'monitoring' },
  { type: 'warning', reason: 'Pod pending', message: 'kibana-visual-5d6e-1 is pending: insufficient CPU on nodes.', time: '5m ago', icon: 'schedule', color: 'tertiary', namespace: 'logging' },
  { type: 'normal', reason: 'Certificate issued', message: 'TLS certificate for grafana.kubezen.io issued successfully.', time: '30m ago', icon: 'verified_user', color: 'primary', namespace: 'cert-manager' },
  { type: 'normal', reason: 'Deployment created', message: 'frontend-staging deployed with image dev-67.', time: '1h ago', icon: 'rocket_launch', color: 'primary', namespace: 'staging' },
  { type: 'warning', reason: 'Pod evicted', message: 'lease-agent-worker06 evicted due to MemoryPressure.', time: '1h ago', icon: 'eject', color: 'error', namespace: 'kube-node-lease' },
  { type: 'normal', reason: 'ConfigMap created', message: 'staging-env ConfigMap created with 5 keys.', time: '5d ago', icon: 'description', color: 'primary', namespace: 'staging' },
  { type: 'normal', reason: 'PVC bound', message: 'prometheus-data-prometheus-server-f7a1 bound to pv-prometheus-data (50Gi).', time: '128d ago', icon: 'storage', color: 'primary', namespace: 'monitoring' },
]

// ── Services ────────────────────────────────────────────────
export const services = [
  { name: 'api-gateway-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.10', externalIP: '-', ports: '80:8080/TCP', age: '45d', selector: { app: 'api-gateway' } },
  { name: 'frontend-web-svc', namespace: 'production-apps', type: 'LoadBalancer', clusterIP: '10.96.0.20', externalIP: '34.120.45.67', ports: '443:8443/TCP', age: '22d', selector: { app: 'frontend-web' } },
  { name: 'redis-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.30', externalIP: '-', ports: '6379:6379/TCP', age: '30d', selector: { app: 'redis-cache' } },
  { name: 'payment-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.80', externalIP: '-', ports: '8080:8080/TCP', age: '15d', selector: { app: 'payment-gateway' } },
  { name: 'user-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.85', externalIP: '-', ports: '8080:8080/TCP', age: '40d', selector: { app: 'user-service' } },
  { name: 'order-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.86', externalIP: '-', ports: '8080:8080/TCP', age: '35d', selector: { app: 'order-processor' } },
  { name: 'search-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.87', externalIP: '-', ports: '9200:9200/TCP', age: '28d', selector: { app: 'search-engine' } },
  { name: 'rabbitmq-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.88', externalIP: '-', ports: '5672:5672/TCP,15672:15672/TCP', age: '60d', selector: { app: 'rabbitmq' } },
  { name: 'postgres-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.89', externalIP: '-', ports: '5432:5432/TCP', age: '98d', selector: { app: 'postgres' } },
  { name: 'notification-svc', namespace: 'production-apps', type: 'ClusterIP', clusterIP: '10.96.0.90', externalIP: '-', ports: '8080:8080/TCP', age: '18d', selector: { app: 'notification-svc' } },
  { name: 'kube-dns', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.96.0.1', externalIP: '-', ports: '53:53/UDP,53:53/TCP', age: '245d', selector: { 'k8s-app': 'coredns' } },
  { name: 'metrics-server-svc', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.96.0.2', externalIP: '-', ports: '443:443/TCP', age: '245d', selector: { 'k8s-app': 'metrics-server' } },
  { name: 'prometheus-svc', namespace: 'monitoring', type: 'NodePort', clusterIP: '10.96.0.40', externalIP: '-', ports: '9090:30090/TCP', age: '128d', selector: { app: 'prometheus' } },
  { name: 'grafana-svc', namespace: 'monitoring', type: 'LoadBalancer', clusterIP: '10.96.0.50', externalIP: '34.120.45.68', ports: '80:3000/TCP', age: '128d', selector: { app: 'grafana' } },
  { name: 'alertmanager-svc', namespace: 'monitoring', type: 'ClusterIP', clusterIP: '10.96.0.55', externalIP: '-', ports: '9093:9093/TCP', age: '128d', selector: { app: 'alertmanager' } },
  { name: 'kube-state-metrics-svc', namespace: 'monitoring', type: 'ClusterIP', clusterIP: '10.96.0.56', externalIP: '-', ports: '8080:8080/TCP', age: '128d', selector: { app: 'kube-state-metrics' } },
  { name: 'kibana-svc', namespace: 'logging', type: 'ClusterIP', clusterIP: '10.96.0.60', externalIP: '-', ports: '5601:5601/TCP', age: '67d', selector: { app: 'kibana' } },
  { name: 'elasticsearch-svc', namespace: 'logging', type: 'ClusterIP', clusterIP: '10.96.0.61', externalIP: '-', ports: '9200:9200/TCP,9300:9300/TCP', age: '67d', selector: { app: 'elasticsearch' } },
  { name: 'logstash-svc', namespace: 'logging', type: 'ClusterIP', clusterIP: '10.96.0.62', externalIP: '-', ports: '5044:5044/TCP', age: '60d', selector: { app: 'logstash' } },
  { name: 'ingress-nginx-svc', namespace: 'ingress-nginx', type: 'LoadBalancer', clusterIP: '10.96.0.70', externalIP: '34.120.45.69', ports: '80:80/TCP,443:443/TCP', age: '200d', selector: { app: 'ingress-nginx' } },
  { name: 'cert-manager-webhook-svc', namespace: 'cert-manager', type: 'ClusterIP', clusterIP: '10.96.0.75', externalIP: '-', ports: '443:443/TCP', age: '180d', selector: { app: 'cert-manager-webhook' } },
  { name: 'user-svc-staging', namespace: 'staging', type: 'ClusterIP', clusterIP: '10.96.0.95', externalIP: '-', ports: '8080:8080/TCP', age: '5d', selector: { app: 'user-service' } },
  { name: 'payment-svc-staging', namespace: 'staging', type: 'ClusterIP', clusterIP: '10.96.0.96', externalIP: '-', ports: '8080:8080/TCP', age: '3d', selector: { app: 'payment' } },
  { name: 'frontend-svc-staging', namespace: 'staging', type: 'ClusterIP', clusterIP: '10.96.0.97', externalIP: '-', ports: '80:80/TCP', age: '1d', selector: { app: 'frontend' } },
  { name: 'api-gateway-staging-svc', namespace: 'staging', type: 'ClusterIP', clusterIP: '10.96.0.98', externalIP: '-', ports: '8080:8080/TCP', age: '7d', selector: { app: 'api-gateway' } },
  { name: 'nginx-demo-svc', namespace: 'default', type: 'ClusterIP', clusterIP: '10.96.0.100', externalIP: '-', ports: '80:80/TCP', age: '30d', selector: { app: 'nginx-demo' } },
  { name: 'hello-app-svc', namespace: 'default', type: 'NodePort', clusterIP: '10.96.0.101', externalIP: '-', ports: '8080:30080/TCP', age: '15d', selector: { app: 'hello-app' } },
  { name: 'cluster-info-svc', namespace: 'kube-public', type: 'ClusterIP', clusterIP: '10.96.0.200', externalIP: '-', ports: '80:80/TCP', age: '245d', selector: { 'k8s-app': 'cluster-info' } },
]

// ── Ingress ─────────────────────────────────────────────────
export const ingresses = [
  { name: 'api-ingress', namespace: 'production-apps', hosts: 'api.kubezen.io', path: '/api', backend: 'api-gateway-svc:80', tls: true, tlsSecret: 'api-tls-secret', age: '45d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx', 'cert-manager.io/cluster-issuer': 'letsencrypt-prod', 'nginx.ingress.kubernetes.io/rate-limit': '100' }, rules: [{ host: 'api.kubezen.io', http: { paths: [{ path: '/api', pathType: 'Prefix', backend: { serviceName: 'api-gateway-svc', servicePort: 80 } }, { path: '/api/v2', pathType: 'Prefix', backend: { serviceName: 'api-gateway-svc', servicePort: 8080 } }] } }] },
  { name: 'web-ingress', namespace: 'production-apps', hosts: 'app.kubezen.io', path: '/', backend: 'frontend-web-svc:80', tls: true, tlsSecret: 'web-tls-secret', age: '22d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx', 'cert-manager.io/cluster-issuer': 'letsencrypt-prod' }, rules: [{ host: 'app.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'frontend-web-svc', servicePort: 80 } }] } }] },
  { name: 'payment-ingress', namespace: 'production-apps', hosts: 'pay.kubezen.io', path: '/', backend: 'payment-svc:8080', tls: true, tlsSecret: 'payment-tls-secret', age: '15d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx', 'nginx.ingress.kubernetes.io/ssl-redirect': 'true' }, rules: [{ host: 'pay.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'payment-svc', servicePort: 8080 } }] } }] },
  { name: 'grafana-ingress', namespace: 'monitoring', hosts: 'grafana.kubezen.io', path: '/', backend: 'grafana-svc:80', tls: true, tlsSecret: 'grafana-tls-secret', age: '128d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx' }, rules: [{ host: 'grafana.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'grafana-svc', servicePort: 80 } }] } }] },
  { name: 'prometheus-ingress', namespace: 'monitoring', hosts: 'prometheus.kubezen.io', path: '/', backend: 'prometheus-svc:9090', tls: true, tlsSecret: 'prometheus-tls', age: '128d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx' }, rules: [{ host: 'prometheus.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'prometheus-svc', servicePort: 9090 } }] } }] },
  { name: 'kibana-ingress', namespace: 'logging', hosts: 'logs.kubezen.io', path: '/', backend: 'kibana-svc:5601', tls: true, tlsSecret: 'kibana-tls-secret', age: '67d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx' }, rules: [{ host: 'logs.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'kibana-svc', servicePort: 5601 } }] } }] },
  { name: 'staging-ingress', namespace: 'staging', hosts: 'staging.kubezen.io', path: '/', backend: 'frontend-svc-staging:80', tls: true, tlsSecret: 'staging-tls-secret', age: '1d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx' }, rules: [{ host: 'staging.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'frontend-svc-staging', servicePort: 80 } }] } }] },
  { name: 'nginx-demo-ingress', namespace: 'default', hosts: 'demo.kubezen.io', path: '/', backend: 'nginx-demo-svc:80', tls: false, tlsSecret: '', age: '30d', className: 'nginx', annotations: { 'kubernetes.io/ingress.class': 'nginx', 'nginx.ingress.kubernetes.io/rewrite-target': '/' }, rules: [{ host: 'demo.kubezen.io', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { serviceName: 'nginx-demo-svc', servicePort: 80 } }] } }] },
]

// 给 Ingress 补默认 labels
ingresses.forEach(i => { if (!i.labels) i.labels = { 'app.kubernetes.io/name': i.name.replace(/-ingress$/, ''), 'app.kubernetes.io/managed-by': 'aliangboard' } })

// ── ConfigMaps ───────────────────────────────────────────────
export const configMaps = [
  { name: 'app-env-vars', namespace: 'production-apps', keys: 8, age: '45d', labels: { app: 'api-gateway', 'app.kubernetes.io/managed-by': 'helm', environment: 'production' }, annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"kind":"ConfigMap","apiVersion":"v1"}', 'helm.sh/hook': 'pre-install' }, data: { DB_HOST: 'postgres-main-svc', DB_PORT: '5432', REDIS_URL: 'redis://redis-svc:6379', LOG_LEVEL: 'info', MAX_CONNECTIONS: '100', CACHE_TTL: '300', API_RATE_LIMIT: '1000', ENABLE_CORS: 'true' } },
  { name: 'nginx-config', namespace: 'production-apps', keys: 2, age: '22d', labels: { app: 'frontend-web' }, annotations: { 'app.kubernetes.io/name': 'nginx-config', 'config.kubernetes.io/version': '1.25' }, data: { 'nginx.conf': 'worker_processes auto; ...' } },
  { name: 'payment-config', namespace: 'production-apps', keys: 4, age: '15d', data: { PROVIDER: 'stripe', CURRENCY: 'USD', TIMEOUT_MS: '5000', RETRY_COUNT: '3' } },
  { name: 'order-config', namespace: 'production-apps', keys: 3, age: '35d', data: { BATCH_SIZE: '50', PROCESSOR_THREADS: '4', QUEUE_PREFETCH: '100' } },
  { name: 'prometheus-config', namespace: 'monitoring', keys: 1, age: '128d', labels: { 'app.kubernetes.io/name': 'prometheus', 'app.kubernetes.io/part-of': 'monitoring-stack' }, annotations: {}, data: { 'prometheus.yml': 'global: ...' } },
  { name: 'grafana-dashboards', namespace: 'monitoring', keys: 5, age: '128d', data: { 'k8s-cluster.json': '...', 'node-metrics.json': '...', 'pod-metrics.json': '...' } },
  { name: 'alertmanager-config', namespace: 'monitoring', keys: 1, age: '128d', data: { 'alertmanager.yml': 'global: ...' } },
  { name: 'fluentd-config', namespace: 'kube-system', keys: 3, age: '200d', data: { 'fluent.conf': '...', 'kubernetes.conf': '...' } },
  { name: 'coredns-config', namespace: 'kube-system', keys: 1, age: '245d', data: { 'Corefile': '.:53 { errors health ... }' } },
  { name: 'logstash-pipeline', namespace: 'logging', keys: 2, age: '60d', data: { 'logstash.conf': 'input { ... } filter { ... } output { ... }' } },
  { name: 'elasticsearch-config', namespace: 'logging', keys: 1, age: '67d', data: { 'elasticsearch.yml': 'cluster.name: efk-logs ...' } },
  { name: 'ingress-nginx-config', namespace: 'ingress-nginx', keys: 3, age: '200d', data: { 'nginx.conf': '...', 'proxy-params.conf': '...' } },
  { name: 'cert-manager-config', namespace: 'cert-manager', keys: 2, age: '180d', data: { 'ACME_EMAIL': 'admin@kubezen.io', 'ACME_SERVER': 'https://acme-v02.api.letsencrypt.org/directory' } },
  { name: 'staging-env', namespace: 'staging', keys: 5, age: '5d', data: { ENV: 'staging', DB_HOST: 'postgres-staging-svc', REDIS_URL: 'redis://redis-staging:6379', LOG_LEVEL: 'debug', DEBUG_MODE: 'true' } },

  // default namespace
  { name: 'nginx-conf', namespace: 'default', keys: 2, age: '30d', data: { 'nginx.conf': 'server { listen 80; location / { proxy_pass http://backend; } }', 'mime.types': 'types { text/html html; }' } },
  { name: 'app-settings', namespace: 'default', keys: 4, age: '15d', data: { APP_NAME: 'hello-app', APP_VERSION: '1.0.0', MAX_RETRIES: '3', TIMEOUT: '30s' } },
  { name: 'kube-root-ca.crt', namespace: 'default', keys: 1, age: '245d', data: { 'ca.crt': 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...' } },

  // kube-public
  { name: 'cluster-info', namespace: 'kube-public', keys: 2, age: '245d', data: { 'kubeconfig': 'apiVersion: v1\nclusters: ...\nkind: Config', 'jwks.json': '{"keys":[...]}' } },

  // kube-node-lease
  { name: 'lease-config', namespace: 'kube-node-lease', keys: 1, age: '245d', data: { 'lease-duration': '40s' } },
]

// ── Secrets ─────────────────────────────────────────────────
// 注意：data 中的值一律以「明文」书写（相当于 K8s 的 stringData），
// cluster store 在加载时会统一 base64 编码进真实的 data 字段，
// 详情页 reveal/编辑时再解码 —— 与真实 K8s Secret 语义保持一致。
const DEMO_CERT = '-----BEGIN CERTIFICATE-----\nMIICazCCAWQCCQC...(demo certificate data)\n-----END CERTIFICATE-----'
const DEMO_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...(demo private key data)\n-----END RSA PRIVATE KEY-----'
const DEMO_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IkRFNTQ3QkU...(demo service-account JWT)'
export const secrets = [
  { name: 'api-tls-secret', namespace: 'production-apps', type: 'kubernetes.io/tls', keys: 2, age: '15d', data: { 'tls.crt': DEMO_CERT, 'tls.key': DEMO_KEY } },
  { name: 'db-credentials', namespace: 'production-apps', type: 'Opaque', keys: 3, age: '98d', data: { username: 'postgres_admin', password: 'P@ssw0rd!2024#Prod', host: 'postgres-main-svc' } },
  { name: 'redis-password', namespace: 'production-apps', type: 'Opaque', keys: 1, age: '30d', data: { password: 'r3d1s_pr0d_s3cr3t!' } },
  { name: 'payment-stripe-key', namespace: 'production-apps', type: 'Opaque', keys: 2, age: '15d', data: { 'STRIPE_PUBLIC_KEY': 'pk_live_xxxxxxxxxxxx', 'STRIPE_SECRET_KEY': 'sk_live_xxxxxxxxxxxx' } },
  { name: 'rabbitmq-credentials', namespace: 'production-apps', type: 'Opaque', keys: 2, age: '60d', data: { username: 'rabbitmq_admin', password: 'r4bb1t_pr0d!' } },
  { name: 'registry-credentials', namespace: 'kube-system', type: 'kubernetes.io/dockerconfigjson', keys: 1, age: '245d', data: { '.dockerconfigjson': '{"auths":{"registry.kubezen.io":{"username":"admin","password":"***"}}}' } },
  { name: 'service-account-token', namespace: 'kube-system', type: 'kubernetes.io/service-account-token', keys: 3, age: '245d', data: { token: DEMO_TOKEN, 'ca.crt': DEMO_CERT, namespace: 'kube-system' } },
  { name: 'grafana-admin', namespace: 'monitoring', type: 'Opaque', keys: 2, age: '128d', data: { 'admin-user': 'admin', 'admin-password': 'gr4f4n4_pr0d!' } },
  { name: 'prometheus-tls', namespace: 'monitoring', type: 'kubernetes.io/tls', keys: 2, age: '128d', data: { 'tls.crt': DEMO_CERT, 'tls.key': DEMO_KEY } },
  { name: 'elasticsearch-credentials', namespace: 'logging', type: 'Opaque', keys: 2, age: '67d', data: { username: 'elastic', password: '3l4st1c_s3cr3t!' } },
  { name: 'ingress-nginx-admission', namespace: 'ingress-nginx', type: 'Opaque', keys: 2, age: '200d', data: { 'tls.crt': DEMO_CERT, 'tls.key': DEMO_KEY } },
  { name: 'cert-manager-webhook-ca', namespace: 'cert-manager', type: 'kubernetes.io/tls', keys: 3, age: '180d', data: { 'ca.crt': DEMO_CERT, 'tls.crt': DEMO_CERT, 'tls.key': DEMO_KEY } },
  { name: 'letsencrypt-account', namespace: 'cert-manager', type: 'Opaque', keys: 1, age: '180d', data: { 'account.key': DEMO_KEY } },
  { name: 'staging-db-credentials', namespace: 'staging', type: 'Opaque', keys: 2, age: '5d', data: { username: 'staging_user', password: 'st4g1ng_db_p4ss!' } },
  { name: 'staging-api-keys', namespace: 'staging', type: 'Opaque', keys: 3, age: '3d', data: { 'API_KEY': 'sk_staging_xxxxxxxx', 'API_SECRET': 'stg_s3cr3t_k3y', 'ENCRYPTION_KEY': 'aes256-stg-key' } },

  // default namespace
  { name: 'default-token', namespace: 'default', type: 'kubernetes.io/service-account-token', keys: 3, age: '245d', data: { token: DEMO_TOKEN, 'ca.crt': DEMO_CERT, namespace: 'default' } },
  { name: 'app-db-secret', namespace: 'default', type: 'Opaque', keys: 3, age: '15d', data: { username: 'app_user', password: '4pp_s3cr3t_p4ss!', host: 'db.internal.default.svc' } },
  { name: 'tls-demo-cert', namespace: 'default', type: 'kubernetes.io/tls', keys: 2, age: '30d', data: { 'tls.crt': DEMO_CERT, 'tls.key': DEMO_KEY } },

  // kube-public
  { name: 'public-info-token', namespace: 'kube-public', type: 'Opaque', keys: 1, age: '245d', data: { token: 'pub_t0k3n_f0r_clust3r_inf0' } },

  // kube-node-lease
  { name: 'lease-agent-token', namespace: 'kube-node-lease', type: 'kubernetes.io/service-account-token', keys: 2, age: '245d', data: { token: DEMO_TOKEN, 'ca.crt': DEMO_CERT } },
]

// ── Persistent Volumes ──────────────────────────────────────
export const persistentVolumes = [
  { name: 'pv-postgres-data', capacity: '50Gi', accessModes: 'RWO', reclaimPolicy: 'Retain', status: 'Bound', claim: 'production-apps/postgres-data-postgres-main-0', storageClass: 'ssd-premium', age: '98d' },
  { name: 'pv-redis-data', capacity: '20Gi', accessModes: 'RWO', reclaimPolicy: 'Delete', status: 'Bound', claim: 'production-apps/redis-data-redis-cache-main-0', storageClass: 'ssd-standard', age: '30d' },
  { name: 'pv-elasticsearch-data', capacity: '100Gi', accessModes: 'RWO', reclaimPolicy: 'Delete', status: 'Bound', claim: 'logging/data-elasticsearch-0', storageClass: 'hdd-standard', age: '67d' },
  { name: 'pv-prometheus-data', capacity: '50Gi', accessModes: 'RWO', reclaimPolicy: 'Retain', status: 'Bound', claim: 'monitoring/prometheus-data-prometheus-server-f7a1', storageClass: 'ssd-standard', age: '128d' },
  { name: 'pv-rabbitmq-data', capacity: '10Gi', accessModes: 'RWO', reclaimPolicy: 'Delete', status: 'Bound', claim: 'production-apps/rabbitmq-data-rabbitmq-broker-0', storageClass: 'ssd-standard', age: '60d' },
  { name: 'pv-nginx-data', capacity: '5Gi', accessModes: 'RWO', reclaimPolicy: 'Delete', status: 'Bound', claim: 'default/nginx-data', storageClass: 'ssd-standard', age: '30d' },
  { name: 'pv-hello-app-data', capacity: '2Gi', accessModes: 'RWO', reclaimPolicy: 'Delete', status: 'Bound', claim: 'default/hello-app-data', storageClass: 'ssd-standard', age: '15d' },
]

export const storageClasses = [
  { name: 'ssd-premium', provisioner: 'pd.csi.storage.gke.io', parameters: 'type=pd-ssd', reclaimPolicy: 'Retain', age: '245d', default: false },
  { name: 'ssd-standard', provisioner: 'pd.csi.storage.gke.io', parameters: 'type=pd-ssd', reclaimPolicy: 'Delete', age: '245d', default: true },
  { name: 'hdd-standard', provisioner: 'pd.csi.storage.gke.io', parameters: 'type=pd-standard', reclaimPolicy: 'Delete', age: '245d', default: false },
  { name: 'local-ssd', provisioner: 'kubernetes.io/local-volume', parameters: 'type=local', reclaimPolicy: 'Delete', age: '180d', default: false },
]

export const pvcs = [
  { name: 'postgres-data-postgres-main-0', namespace: 'production-apps', status: 'Bound', capacity: '50Gi', accessModes: 'RWO', storageClass: 'ssd-premium', volume: 'pv-postgres-data', age: '98d' },
  { name: 'redis-data-redis-cache-main-0', namespace: 'production-apps', status: 'Bound', capacity: '20Gi', accessModes: 'RWO', storageClass: 'ssd-standard', volume: 'pv-redis-data', age: '30d' },
  { name: 'rabbitmq-data-rabbitmq-broker-0', namespace: 'production-apps', status: 'Bound', capacity: '10Gi', accessModes: 'RWO', storageClass: 'ssd-standard', volume: 'pv-rabbitmq-data', age: '60d' },
  { name: 'data-elasticsearch-0', namespace: 'logging', status: 'Bound', capacity: '100Gi', accessModes: 'RWO', storageClass: 'hdd-standard', volume: 'pv-elasticsearch-data', age: '67d' },
  { name: 'prometheus-data-prometheus-server-f7a1', namespace: 'monitoring', status: 'Bound', capacity: '50Gi', accessModes: 'RWO', storageClass: 'ssd-standard', volume: 'pv-prometheus-data', age: '128d' },
  { name: 'backup-storage', namespace: 'kube-system', status: 'Pending', capacity: '200Gi', accessModes: 'RWO', storageClass: 'hdd-standard', volume: '', age: '2h' },
  { name: 'nginx-data', namespace: 'default', status: 'Bound', capacity: '5Gi', accessModes: 'RWO', storageClass: 'ssd-standard', volume: 'pv-nginx-data', age: '30d' },
  { name: 'hello-app-data', namespace: 'default', status: 'Bound', capacity: '2Gi', accessModes: 'RWO', storageClass: 'ssd-standard', volume: 'pv-hello-app-data', age: '15d' },
]

// ── RBAC ────────────────────────────────────────────────────
export const roles = [
  { name: 'admin', namespace: '', scope: 'Cluster', bindings: 3 },
  { name: 'edit', namespace: '', scope: 'Cluster', bindings: 5 },
  { name: 'view', namespace: '', scope: 'Cluster', bindings: 8 },
  { name: 'prometheus-k8s', namespace: 'monitoring', scope: 'Namespace', bindings: 2 },
  { name: 'fluentd-reader', namespace: 'kube-system', scope: 'Namespace', bindings: 1 },
  { name: 'cert-manager', namespace: 'cert-manager', scope: 'Namespace', bindings: 1 },
  { name: 'ingress-nginx', namespace: 'ingress-nginx', scope: 'Namespace', bindings: 1 },
  { name: 'developer', namespace: 'production-apps', scope: 'Namespace', bindings: 4 },
  { name: 'viewer', namespace: 'staging', scope: 'Namespace', bindings: 3 },
  { name: 'log-collector', namespace: 'logging', scope: 'Namespace', bindings: 1 },
]

export const serviceAccounts = [
  { name: 'default', namespace: 'default', age: '245d' },
  { name: 'prometheus-sa', namespace: 'monitoring', age: '128d' },
  { name: 'fluentd-sa', namespace: 'kube-system', age: '200d' },
  { name: 'cert-manager-sa', namespace: 'cert-manager', age: '180d' },
  { name: 'ingress-nginx-sa', namespace: 'ingress-nginx', age: '200d' },
  { name: 'deployer-sa', namespace: 'production-apps', age: '98d' },
  { name: 'elasticsearch-sa', namespace: 'logging', age: '67d' },
  { name: 'staging-deployer', namespace: 'staging', age: '85d' },
]

// ── RoleBindings ────────────────────────────────────────────
export const roleBindings = [
  { name: 'admin-binding', namespace: 'production-apps', roleName: 'admin', roleKind: 'ClusterRole', subjects: [{ kind: 'User', name: 'admin@kubezen.io' }], age: '98d' },
  { name: 'developer-binding', namespace: 'production-apps', roleName: 'developer', roleKind: 'Role', subjects: [{ kind: 'Group', name: 'developers' }, { kind: 'User', name: 'dev1@kubezen.io' }], age: '98d' },
  { name: 'viewer-binding', namespace: 'staging', roleName: 'viewer', roleKind: 'Role', subjects: [{ kind: 'Group', name: 'qa-team' }], age: '85d' },
  { name: 'prometheus-binding', namespace: 'monitoring', roleName: 'prometheus-k8s', roleKind: 'Role', subjects: [{ kind: 'ServiceAccount', name: 'prometheus-sa', namespace: 'monitoring' }], age: '128d' },
  { name: 'fluentd-binding', namespace: 'kube-system', roleName: 'fluentd-reader', roleKind: 'Role', subjects: [{ kind: 'ServiceAccount', name: 'fluentd-sa', namespace: 'kube-system' }], age: '200d' },
  { name: 'cert-manager-binding', namespace: 'cert-manager', roleName: 'cert-manager', roleKind: 'Role', subjects: [{ kind: 'ServiceAccount', name: 'cert-manager-sa', namespace: 'cert-manager' }], age: '180d' },
  { name: 'ingress-nginx-binding', namespace: 'ingress-nginx', roleName: 'ingress-nginx', roleKind: 'Role', subjects: [{ kind: 'ServiceAccount', name: 'ingress-nginx-sa', namespace: 'ingress-nginx' }], age: '200d' },
  { name: 'log-collector-binding', namespace: 'logging', roleName: 'log-collector', roleKind: 'Role', subjects: [{ kind: 'ServiceAccount', name: 'elasticsearch-sa', namespace: 'logging' }], age: '67d' },
  { name: 'staging-deployer-binding', namespace: 'staging', roleName: 'edit', roleKind: 'ClusterRole', subjects: [{ kind: 'ServiceAccount', name: 'staging-deployer', namespace: 'staging' }], age: '85d' },
]

// ── NetworkPolicies ─────────────────────────────────────────
export const networkPolicies = [
  { name: 'deny-all-ingress', namespace: 'production-apps', podSelector: {}, policyTypes: ['Ingress'], ingressRules: [], egressRules: [], age: '98d' },
  { name: 'allow-api-gateway', namespace: 'production-apps', podSelector: { app: 'api-gateway' }, policyTypes: ['Ingress'], ingressRules: [{ from: [{ type: 'namespaceSelector', matchLabels: { name: 'ingress-nginx' } }], ports: [{ port: 8080, protocol: 'TCP' }] }], egressRules: [], age: '45d' },
  { name: 'allow-frontend-to-api', namespace: 'production-apps', podSelector: { app: 'frontend-web' }, policyTypes: ['Ingress', 'Egress'], ingressRules: [{ from: [{ type: 'namespaceSelector', matchLabels: { name: 'ingress-nginx' } }] }], egressRules: [{ to: [{ type: 'podSelector', matchLabels: { app: 'api-gateway' } }] }], age: '22d' },
  { name: 'monitoring-egress', namespace: 'monitoring', podSelector: {}, policyTypes: ['Egress'], ingressRules: [], egressRules: [{ to: [{ type: 'namespaceSelector', matchLabels: {} }], ports: [{ port: 9090, protocol: 'TCP' }, { port: 9100, protocol: 'TCP' }] }], age: '128d' },
  { name: 'elasticsearch-isolation', namespace: 'logging', podSelector: { app: 'elasticsearch' }, policyTypes: ['Ingress', 'Egress'], ingressRules: [{ from: [{ type: 'podSelector', matchLabels: { app: 'logstash' } }, { type: 'podSelector', matchLabels: { app: 'kibana' } }] }], egressRules: [], age: '67d' },
  { name: 'default-deny', namespace: 'staging', podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingressRules: [], egressRules: [], age: '85d' },
]

// ── HPAs ────────────────────────────────────────────────────
export const hpas = [
  { name: 'api-gateway-hpa', namespace: 'production-apps', targetName: 'api-gateway-v2', targetKind: 'Deployment', minReplicas: 2, maxReplicas: 10, currentReplicas: 3, cpuTarget: 70, memoryTarget: 80, currentCPU: 45, currentMemory: 55, status: 'Ok', age: '30d' },
  { name: 'frontend-hpa', namespace: 'production-apps', targetName: 'frontend-web', targetKind: 'Deployment', minReplicas: 2, maxReplicas: 8, currentReplicas: 4, cpuTarget: 75, memoryTarget: 80, currentCPU: 32, currentMemory: 48, status: 'Ok', age: '20d' },
  { name: 'payment-hpa', namespace: 'production-apps', targetName: 'payment-gateway', targetKind: 'Deployment', minReplicas: 2, maxReplicas: 6, currentReplicas: 3, cpuTarget: 60, memoryTarget: 70, currentCPU: 89, currentMemory: 82, status: 'Scaling', age: '15d' },
  { name: 'search-hpa', namespace: 'production-apps', targetName: 'search-engine', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 5, currentReplicas: 2, cpuTarget: 80, memoryTarget: 85, currentCPU: 20, currentMemory: 30, status: 'Ok', age: '28d' },
  { name: 'logstash-hpa', namespace: 'logging', targetName: 'logstash-pipeline', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 4, currentReplicas: 2, cpuTarget: 70, memoryTarget: 75, currentCPU: 20, currentMemory: 48, status: 'Ok', age: '60d' },
]

// ── ResourceQuotas ──────────────────────────────────────────
export const resourceQuotas = [
  { name: 'production-quota', namespace: 'production-apps', hard: { 'limits.cpu': '32', 'limits.memory': '64Gi', 'pods': '50', 'services': '20', 'persistentvolumeclaims': '10', 'requests.storage': '200Gi' }, used: { 'limits.cpu': '18.5', 'limits.memory': '38Gi', 'pods': '24', 'services': '10', 'persistentvolumeclaims': '3', 'requests.storage': '80Gi' }, age: '98d' },
  { name: 'staging-quota', namespace: 'staging', hard: { 'limits.cpu': '8', 'limits.memory': '16Gi', 'pods': '15', 'services': '10' }, used: { 'limits.cpu': '3.5', 'limits.memory': '7Gi', 'pods': '6', 'services': '4' }, age: '85d' },
  { name: 'monitoring-quota', namespace: 'monitoring', hard: { 'limits.cpu': '8', 'limits.memory': '16Gi', 'pods': '20', 'persistentvolumeclaims': '5' }, used: { 'limits.cpu': '4.2', 'limits.memory': '8.5Gi', 'pods': '12', 'persistentvolumeclaims': '1' }, age: '128d' },
  { name: 'logging-quota', namespace: 'logging', hard: { 'limits.cpu': '12', 'limits.memory': '24Gi', 'pods': '15', 'requests.storage': '200Gi' }, used: { 'limits.cpu': '3.7', 'limits.memory': '9.5Gi', 'pods': '6', 'requests.storage': '100Gi' }, age: '67d' },
]

// ── LimitRanges ─────────────────────────────────────────────
export const limitRanges = [
  { name: 'production-limits', namespace: 'production-apps', defaultCPU: '500m', defaultMemory: '512Mi', defaultRequestCPU: '250m', defaultRequestMemory: '256Mi', maxCPU: '4', maxMemory: '8Gi', minCPU: '50m', minMemory: '64Mi', age: '98d' },
  { name: 'staging-limits', namespace: 'staging', defaultCPU: '250m', defaultMemory: '256Mi', defaultRequestCPU: '100m', defaultRequestMemory: '128Mi', maxCPU: '2', maxMemory: '4Gi', minCPU: '50m', minMemory: '64Mi', age: '85d' },
  { name: 'monitoring-limits', namespace: 'monitoring', defaultCPU: '500m', defaultMemory: '512Mi', defaultRequestCPU: '250m', defaultRequestMemory: '256Mi', maxCPU: '4', maxMemory: '8Gi', minCPU: '100m', minMemory: '128Mi', age: '128d' },
  { name: 'default-limits', namespace: 'default', defaultCPU: '250m', defaultMemory: '256Mi', defaultRequestCPU: '100m', defaultRequestMemory: '128Mi', maxCPU: '1', maxMemory: '2Gi', minCPU: '50m', minMemory: '32Mi', age: '245d' },
]

// ── Role details (extended) ─────────────────────────────────
// Enrich existing roles with rules data
const roleRulesMap = {
  'admin': { rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
  'edit': { rules: [{ apiGroups: [''], resources: ['pods', 'services', 'configmaps', 'secrets', 'deployments'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] }] },
  'view': { rules: [{ apiGroups: [''], resources: ['pods', 'services', 'configmaps', 'deployments'], verbs: ['get', 'list', 'watch'] }] },
  'prometheus-k8s': { rules: [{ apiGroups: [''], resources: ['pods', 'nodes', 'services', 'endpoints'], verbs: ['get', 'list', 'watch'] }] },
  'fluentd-reader': { rules: [{ apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list', 'watch'] }] },
  'cert-manager': { rules: [{ apiGroups: ['cert-manager.io'], resources: ['certificates', 'issuers', 'clusterissuers'], verbs: ['*'] }] },
  'ingress-nginx': { rules: [{ apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['*'] }] },
  'developer': { rules: [{ apiGroups: [''], resources: ['pods', 'services', 'configmaps'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] }, { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] }] },
  'viewer': { rules: [{ apiGroups: [''], resources: ['pods', 'services', 'configmaps'], verbs: ['get', 'list', 'watch'] }] },
  'log-collector': { rules: [{ apiGroups: [''], resources: ['pods', 'pods/log', 'namespaces'], verbs: ['get', 'list', 'watch'] }] },
}

// Enrich roles with rules
roles.forEach(r => {
  const extra = roleRulesMap[r.name]
  if (extra) Object.assign(r, extra)
})

// ── Workload 对 ConfigMap/Secret 的引用关系 ─────────────────
// type: envFrom (整体注入环境变量) / env (单个 key 作为环境变量) / volume (卷挂载) / imagePullSecrets (镜像拉取凭证)
const workloadReferencesMap = {
  // production-apps
  'api-gateway-v2': [
    { kind: 'ConfigMap', name: 'app-env-vars', type: 'envFrom' },
    { kind: 'Secret', name: 'api-tls-secret', type: 'volume', mountPath: '/etc/nginx/tls' },
  ],
  'frontend-web': [
    { kind: 'ConfigMap', name: 'nginx-config', type: 'volume', mountPath: '/etc/nginx' },
    { kind: 'ConfigMap', name: 'app-env-vars', type: 'envFrom' },
  ],
  'order-processor': [
    { kind: 'ConfigMap', name: 'order-config', type: 'envFrom' },
    { kind: 'ConfigMap', name: 'app-env-vars', type: 'envFrom' },
    { kind: 'Secret', name: 'db-credentials', type: 'env', key: 'password', envName: 'DB_PASSWORD' },
  ],
  'notification-svc': [
    { kind: 'ConfigMap', name: 'app-env-vars', type: 'envFrom' },
  ],
  'payment-gateway': [
    { kind: 'ConfigMap', name: 'payment-config', type: 'envFrom' },
    { kind: 'Secret', name: 'payment-stripe-key', type: 'env', key: 'STRIPE_SECRET_KEY', envName: 'STRIPE_SECRET_KEY' },
  ],
  'user-service': [
    { kind: 'ConfigMap', name: 'app-env-vars', type: 'envFrom' },
    { kind: 'Secret', name: 'db-credentials', type: 'envFrom' },
  ],
  'search-engine': [
    { kind: 'ConfigMap', name: 'app-env-vars', type: 'envFrom' },
  ],
  'redis-cache-main': [
    { kind: 'Secret', name: 'redis-password', type: 'env', key: 'password', envName: 'REDIS_PASSWORD' },
  ],
  'postgres-main': [
    { kind: 'Secret', name: 'db-credentials', type: 'envFrom' },
  ],
  'rabbitmq-broker': [
    { kind: 'Secret', name: 'rabbitmq-credentials', type: 'envFrom' },
  ],

  // kube-system
  'coredns': [
    { kind: 'ConfigMap', name: 'coredns-config', type: 'volume', mountPath: '/etc/coredns' },
  ],
  'metrics-server': [
    { kind: 'Secret', name: 'registry-credentials', type: 'imagePullSecrets' },
  ],
  'fluentd-logging': [
    { kind: 'ConfigMap', name: 'fluentd-config', type: 'volume', mountPath: '/etc/fluent' },
    { kind: 'Secret', name: 'registry-credentials', type: 'imagePullSecrets' },
  ],
  'kube-proxy': [
    { kind: 'Secret', name: 'registry-credentials', type: 'imagePullSecrets' },
  ],

  // monitoring
  'prometheus-server': [
    { kind: 'ConfigMap', name: 'prometheus-config', type: 'volume', mountPath: '/etc/prometheus' },
    { kind: 'Secret', name: 'prometheus-tls', type: 'volume', mountPath: '/etc/prometheus/tls' },
  ],
  'grafana-dashboard': [
    { kind: 'ConfigMap', name: 'grafana-dashboards', type: 'volume', mountPath: '/var/lib/grafana/dashboards' },
    { kind: 'Secret', name: 'grafana-admin', type: 'envFrom' },
  ],

  // logging
  'elasticsearch': [
    { kind: 'ConfigMap', name: 'elasticsearch-config', type: 'volume', mountPath: '/usr/share/elasticsearch/config' },
    { kind: 'Secret', name: 'elasticsearch-credentials', type: 'envFrom' },
  ],
  'kibana-visual': [
    { kind: 'Secret', name: 'elasticsearch-credentials', type: 'env', key: 'password', envName: 'ELASTICSEARCH_PASSWORD' },
  ],
  'logstash-pipeline': [
    { kind: 'ConfigMap', name: 'logstash-pipeline', type: 'volume', mountPath: '/usr/share/logstash/pipeline' },
  ],

  // ingress-nginx
  'ingress-nginx-controller': [
    { kind: 'ConfigMap', name: 'ingress-nginx-config', type: 'volume', mountPath: '/etc/nginx' },
  ],

  // cert-manager
  'cert-manager-controller': [
    { kind: 'ConfigMap', name: 'cert-manager-config', type: 'envFrom' },
  ],

  // staging
  'user-service-staging': [
    { kind: 'ConfigMap', name: 'staging-env', type: 'envFrom' },
    { kind: 'Secret', name: 'staging-db-credentials', type: 'envFrom' },
  ],
  'payment-staging': [
    { kind: 'Secret', name: 'staging-api-keys', type: 'env', key: 'API_KEY', envName: 'API_KEY' },
    { kind: 'ConfigMap', name: 'staging-env', type: 'envFrom' },
  ],
  'frontend-staging': [
    { kind: 'ConfigMap', name: 'staging-env', type: 'envFrom' },
  ],

  // default
  'nginx-demo': [
    { kind: 'ConfigMap', name: 'nginx-conf', type: 'volume', mountPath: '/etc/nginx/conf.d' },
  ],
  'hello-app': [
    { kind: 'ConfigMap', name: 'app-settings', type: 'envFrom' },
    { kind: 'Secret', name: 'app-db-secret', type: 'env', key: 'password', envName: 'DB_PASSWORD' },
  ],
}

// Enrich workloads with their ConfigMap/Secret references
workloads.forEach(w => {
  const refs = workloadReferencesMap[w.name]
  if (refs) w.references = refs
})

// ── Workload 微服务分层（对标 Kuboard tier）─────────────────
// web=表现层 gateway=网关层 svc=服务层 cloud=中间件 db=持久层 monitor=监控 default=默认
const workloadTierMap = {
  // 表现层 web
  'frontend-web': 'web', 'kibana-visual': 'web', 'frontend-staging': 'web', 'nginx-demo': 'web', 'hello-app': 'web',
  // 网关层 gateway
  'api-gateway-v2': 'gateway', 'ingress-nginx-controller': 'gateway', 'ingress-nginx-defaultbackend': 'gateway', 'api-gateway-staging': 'gateway',
  // 服务层 svc
  'order-processor': 'svc', 'notification-svc': 'svc', 'payment-gateway': 'svc', 'user-service': 'svc', 'search-engine': 'svc',
  'search-indexer': 'svc', 'auth-worker': 'svc', 'logstash-pipeline': 'svc', 'user-service-staging': 'svc', 'payment-staging': 'svc',
  // 中间件层 cloud
  'rabbitmq-broker': 'cloud',
  // 持久层 db
  'redis-cache-main': 'db', 'postgres-main': 'db', 'elasticsearch': 'db',
  // 监控层 monitor
  'metrics-server': 'monitor', 'fluentd-logging': 'monitor', 'prometheus-server': 'monitor', 'grafana-dashboard': 'monitor',
  'kube-state-metrics': 'monitor', 'alertmanager': 'monitor', 'node-exporter': 'monitor',
  // 默认层 default（核心组件/任务/未分类）
  'coredns': 'default', 'nvidia-device-plugin': 'default', 'kube-proxy': 'default', 'backup-job': 'default',
  'db-migrator': 'default', 'cert-manager-controller': 'default', 'cert-manager-webhook': 'default', 'cert-manager-cainjector': 'default',
  'db-migrate-staging': 'default',
}
workloads.forEach(w => {
  if (workloadTierMap[w.name]) w.tier = workloadTierMap[w.name]
})

// ── Events 关联资源（用于事件点击跳转）──────────────────────
const eventRelationMap = {
  'ReplicaSet scaled up': { kind: 'Deployment', name: 'frontend-web' },
  'Node pressure detected': { kind: 'Node', name: 'worker-node-04' },
  'New Ingress created': { kind: 'Ingress', name: 'api-ingress' },
  'Configuration updated': { kind: 'ConfigMap', name: 'app-env-vars' },
  'Pod scheduled': { kind: 'Deployment', name: 'payment-gateway' },
  'ImagePullBackOff': { kind: 'Pod', name: 'auth-worker-01-9d4e2' },
  'HorizontalPodAutoscaler': { kind: 'Deployment', name: 'api-gateway-v2' },
  'Secret updated': { kind: 'Secret', name: 'api-tls-secret' },
  'Pod started': { kind: 'Pod', name: 'prometheus-server-f7a1' },
  'Pod pending': { kind: 'Pod', name: 'kibana-visual-5d6e-1' },
  'Certificate issued': { kind: 'Ingress', name: 'grafana-ingress' },
  'Deployment created': { kind: 'Deployment', name: 'frontend-staging' },
  'Pod evicted': { kind: 'Pod', name: 'lease-agent-worker06' },
  'ConfigMap created': { kind: 'ConfigMap', name: 'staging-env' },
  'PVC bound': { kind: 'PVC', name: 'prometheus-data-prometheus-server-f7a1' },
}
events.forEach(e => {
  const rel = eventRelationMap[e.reason]
  if (rel) { e.relatedKind = rel.kind; e.relatedName = rel.name }
})

// ── 多集群 ──────────────────────────────────────────────────
export const clusters = [
  { name: 'Production-Cluster-01', apiServer: 'https://api.prod-cluster.kubezen.io:6443', version: 'k8s v1.28.2', status: 'Healthy', nodeCount: 8, podCount: 247, context: 'prod-context', current: true, distribution: 'kubeadm' },
  { name: 'Staging-Cluster', apiServer: 'https://api.staging-cluster.kubezen.io:6443', version: 'k8s v1.27.4', status: 'Healthy', nodeCount: 4, podCount: 89, context: 'staging-context', current: false, distribution: 'kubeadm' },
  { name: 'Dev-Cluster', apiServer: 'https://api.dev-cluster.kubezen.io:6443', version: 'k8s v1.29.0', status: 'Degraded', nodeCount: 3, podCount: 45, context: 'dev-context', current: false, distribution: 'kind' },
  { name: 'Edge-Cluster-CN', apiServer: 'https://api.edge-cn.kubezen.io:6443', version: 'k8s v1.28.2', status: 'Healthy', nodeCount: 2, podCount: 18, context: 'edge-cn-context', current: false, distribution: 'k3s' },
]

// ── 审计日志 ────────────────────────────────────────────────
export const auditLogs = [
  { user: 'admin@kubezen.io', verb: 'create', resource: 'Deployment/api-gateway-v2', namespace: 'production-apps', time: '5m ago', timestamp: '2024-06-12T14:35:00Z', ip: '10.0.0.5', code: 201 },
  { user: 'dev1@kubezen.io', verb: 'update', resource: 'ConfigMap/app-env-vars', namespace: 'production-apps', time: '15m ago', timestamp: '2024-06-12T14:25:00Z', ip: '10.0.0.12', code: 200 },
  { user: 'admin@kubezen.io', verb: 'delete', resource: 'Pod/old-frontend-abc', namespace: 'default', time: '32m ago', timestamp: '2024-06-12T14:08:00Z', ip: '10.0.0.5', code: 204 },
  { user: 'ci-bot', verb: 'create', resource: 'Deployment/frontend-staging', namespace: 'staging', time: '1h ago', timestamp: '2024-06-12T13:40:00Z', ip: '10.0.0.20', code: 201 },
  { user: 'admin@kubezen.io', verb: 'patch', resource: 'Deployment/payment-gateway', namespace: 'production-apps', time: '2h ago', timestamp: '2024-06-12T12:50:00Z', ip: '10.0.0.5', code: 200 },
  { user: 'dev2@kubezen.io', verb: 'create', resource: 'Secret/staging-api-keys', namespace: 'staging', time: '3h ago', timestamp: '2024-06-12T11:30:00Z', ip: '10.0.0.13', code: 201 },
  { user: 'admin@kubezen.io', verb: 'delete', resource: 'ConfigMap/old-config', namespace: 'production-apps', time: '4h ago', timestamp: '2024-06-12T10:45:00Z', ip: '10.0.0.5', code: 204 },
  { user: 'ci-bot', verb: 'update', resource: 'Deployment/api-gateway-staging', namespace: 'staging', time: '5h ago', timestamp: '2024-06-12T09:30:00Z', ip: '10.0.0.20', code: 200 },
  { user: 'dev1@kubezen.io', verb: 'create', resource: 'Ingress/payment-ingress', namespace: 'production-apps', time: '6h ago', timestamp: '2024-06-12T08:15:00Z', ip: '10.0.0.12', code: 201 },
  { user: 'admin@kubezen.io', verb: 'patch', resource: 'Node/worker-node-04', namespace: '', time: '8h ago', timestamp: '2024-06-12T06:00:00Z', ip: '10.0.0.5', code: 200 },
  { user: 'monitor-bot', verb: 'get', resource: 'PodList', namespace: '', time: '8h ago', timestamp: '2024-06-12T06:05:00Z', ip: '10.0.0.30', code: 200 },
  { user: 'dev2@kubezen.io', verb: 'create', resource: 'Service/payment-svc', namespace: 'production-apps', time: '12h ago', timestamp: '2024-06-12T02:00:00Z', ip: '10.0.0.13', code: 201 },
]

// ── CRD 自定义资源定义 ──────────────────────────────────────
export const customResourceDefinitions = [
  {
    name: 'certificates.cert-manager.io', group: 'cert-manager.io', version: 'v1', kind: 'Certificate', scope: 'Namespaced', namespaced: true, description: '请求并续期 TLS 证书',
    instances: [
      { name: 'api-tls-cert', namespace: 'production-apps', status: 'Ready', age: '15d' },
      { name: 'web-tls-cert', namespace: 'production-apps', status: 'Ready', age: '22d' },
      { name: 'grafana-tls-cert', namespace: 'monitoring', status: 'Ready', age: '128d' },
      { name: 'kibana-tls-cert', namespace: 'logging', status: 'Pending', age: '67d' },
    ],
  },
  {
    name: 'issuers.cert-manager.io', group: 'cert-manager.io', version: 'v1', kind: 'Issuer', scope: 'Namespaced', namespaced: true, description: '命名空间级证书颁发机构',
    instances: [
      { name: 'letsencrypt-prod', namespace: 'production-apps', status: 'Ready', age: '98d' },
      { name: 'self-signed', namespace: 'monitoring', status: 'Ready', age: '128d' },
    ],
  },
  {
    name: 'clusterissuers.cert-manager.io', group: 'cert-manager.io', version: 'v1', kind: 'ClusterIssuer', scope: 'Cluster', namespaced: false, description: '集群级证书颁发机构',
    instances: [
      { name: 'letsencrypt-prod', namespace: '', status: 'Ready', age: '180d' },
      { name: 'letsencrypt-staging', namespace: '', status: 'Ready', age: '180d' },
    ],
  },
  {
    name: 'ingressclasses.networking.k8s.io', group: 'networking.k8s.io', version: 'v1', kind: 'IngressClass', scope: 'Cluster', namespaced: false, description: 'Ingress 控制器类别',
    instances: [
      { name: 'nginx', namespace: '', status: 'Active', age: '200d' },
      { name: 'traefik', namespace: '', status: 'Active', age: '90d' },
    ],
  },
  {
    name: 'horizontalpodautoscalers.autoscaling', group: 'autoscaling', version: 'v2', kind: 'HorizontalPodAutoscaler', scope: 'Namespaced', namespaced: true, description: '工作负载水平自动伸缩',
    instances: [
      { name: 'api-gateway-hpa', namespace: 'production-apps', status: 'Ready', age: '30d' },
      { name: 'payment-hpa', namespace: 'production-apps', status: 'Ready', age: '15d' },
    ],
  },
  {
    name: 'alertmanagerconfigs.monitoring.coreos.com', group: 'monitoring.coreos.com', version: 'v1', kind: 'AlertmanagerConfig', scope: 'Namespaced', namespaced: true, description: 'Alertmanager 告警路由配置',
    instances: [
      { name: 'prod-alerts', namespace: 'monitoring', status: 'Ready', age: '128d' },
    ],
  },
]

// ── ClusterRoleBinding（集群级角色绑定）─────────────────────
export const clusterRoleBindings = [
  { name: 'cluster-admin-binding', roleName: 'admin', roleKind: 'ClusterRole', subjects: [{ kind: 'Group', name: 'system:masters' }], age: '245d' },
  { name: 'cluster-readonly-binding', roleName: 'view', roleKind: 'ClusterRole', subjects: [{ kind: 'Group', name: 'developers' }, { kind: 'Group', name: 'qa-team' }], age: '120d' },
  { name: 'cluster-editor-binding', roleName: 'edit', roleKind: 'ClusterRole', subjects: [{ kind: 'User', name: 'ops@kubezen.io' }], age: '90d' },
  { name: 'prometheus-cluster-binding', roleName: 'view', roleKind: 'ClusterRole', subjects: [{ kind: 'ServiceAccount', name: 'prometheus-sa', namespace: 'monitoring' }], age: '128d' },
  { name: 'cert-manager-cluster-binding', roleName: 'cert-manager', roleKind: 'ClusterRole', subjects: [{ kind: 'ServiceAccount', name: 'cert-manager-sa', namespace: 'cert-manager' }], age: '180d' },
  { name: 'fluentd-cluster-binding', roleName: 'fluentd-reader', roleKind: 'ClusterRole', subjects: [{ kind: 'ServiceAccount', name: 'fluentd-sa', namespace: 'kube-system' }], age: '200d' },
]

// ── PodDisruptionBudget（中断预算，命名空间级）──────────────
export const podDisruptionBudgets = [
  { name: 'api-gateway-pdb', namespace: 'production-apps', minAvailable: '2', maxUnavailable: '', selector: { app: 'api-gateway' }, allowedDisruptions: 1, currentHealthy: 3, desiredHealthy: 2, age: '30d' },
  { name: 'frontend-pdb', namespace: 'production-apps', minAvailable: '', maxUnavailable: '1', selector: { app: 'frontend-web' }, allowedDisruptions: 1, currentHealthy: 4, desiredHealthy: 3, age: '20d' },
  { name: 'payment-pdb', namespace: 'production-apps', minAvailable: '2', maxUnavailable: '', selector: { app: 'payment-gateway' }, allowedDisruptions: 1, currentHealthy: 3, desiredHealthy: 2, age: '15d' },
  { name: 'postgres-pdb', namespace: 'production-apps', minAvailable: '1', maxUnavailable: '', selector: { app: 'postgres' }, allowedDisruptions: 0, currentHealthy: 1, desiredHealthy: 1, age: '98d' },
  { name: 'prometheus-pdb', namespace: 'monitoring', minAvailable: '1', maxUnavailable: '', selector: { app: 'prometheus' }, allowedDisruptions: 0, currentHealthy: 1, desiredHealthy: 1, age: '128d' },
  { name: 'elasticsearch-pdb', namespace: 'logging', minAvailable: '2', maxUnavailable: '', selector: { app: 'elasticsearch' }, allowedDisruptions: 1, currentHealthy: 3, desiredHealthy: 2, age: '67d' },
  { name: 'staging-frontend-pdb', namespace: 'staging', minAvailable: '', maxUnavailable: '1', selector: { app: 'frontend' }, allowedDisruptions: 1, currentHealthy: 2, desiredHealthy: 1, age: '5d' },
]

// ── PriorityClass（优先级类，集群级）────────────────────────
export const priorityClasses = [
  { name: 'system-node-critical', value: 2000001000, globalDefault: false, description: '用于系统节点关键 Pod（不可被驱逐）', age: '245d' },
  { name: 'system-cluster-critical', value: 2000000000, globalDefault: false, description: '用于系统集群关键 Pod', age: '245d' },
  { name: 'prod-high', value: 1000000, globalDefault: false, description: '生产环境高优先级应用（核心服务）', age: '90d' },
  { name: 'prod-medium', value: 500000, globalDefault: false, description: '生产环境中优先级应用', age: '90d' },
  { name: 'default-priority', value: 100000, globalDefault: true, description: '默认优先级（无显式指定时使用）', age: '90d' },
  { name: 'batch-low', value: 10000, globalDefault: false, description: '低优先级批处理任务', age: '60d' },
]
