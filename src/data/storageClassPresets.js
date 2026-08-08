// StorageClass 创建预设 + 参数纯函数。无 Vue 依赖,便于 scripts/test.mjs 直接 import。
// 每个 preset.requiredParams 里的键值含 <...> 占位符时,创建弹窗阻断(避免静默失败的坏 SC)。

export const STORAGE_CLASS_PRESETS = [
  // === 本地/单机 ===
  { id: 'local-path', family: 'local', label: 'storage.presets.local-path.label', hint: 'storage.presets.local-path.hint',
    provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'local-path', parameters: {}, requiredParams: [] },
  { id: 'no-provisioner', family: 'local', label: 'storage.presets.no-provisioner.label', hint: 'storage.presets.no-provisioner.hint',
    provisioner: 'kubernetes.io/no-provisioner', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'manual', parameters: {}, requiredParams: [] },
  { id: 'host-path', family: 'local', label: 'storage.presets.host-path.label', hint: 'storage.presets.host-path.hint',
    provisioner: 'kubernetes.io/host-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'host-path', parameters: {}, requiredParams: [] },
  // === 分布式块存储 ===
  { id: 'longhorn', family: 'distributed', label: 'storage.presets.longhorn.label', hint: 'storage.presets.longhorn.hint',
    provisioner: 'driver.longhorn.io', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'longhorn',
    parameters: { numberOfReplicas: '3', staleReplicaTimeout: '30' }, requiredParams: [] },
  { id: 'ceph-rbd', family: 'distributed', label: 'storage.presets.ceph-rbd.label', hint: 'storage.presets.ceph-rbd.hint',
    provisioner: 'rook-ceph.rbd.csi.ceph.com', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'rook-ceph-block',
    parameters: {
      clusterID: '<rook-ceph>', pool: '<replicapool>', imageFormat: '2', imageFeatures: 'layering',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/provisioner-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/controller-expand-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node',
      'csi.storage.k8s.io/node-stage-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/fstype': 'ext4',
    }, requiredParams: ['clusterID', 'pool'] },
  { id: 'cephfs', family: 'distributed', label: 'storage.presets.cephfs.label', hint: 'storage.presets.cephfs.hint',
    provisioner: 'rook-ceph.cephfs.csi.ceph.com', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'rook-cephfs',
    parameters: {
      clusterID: '<rook-ceph>', fsName: '<cephfs>',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-cephfs-provisioner',
      'csi.storage.k8s.io/provisioner-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-cephfs-provisioner',
      'csi.storage.k8s.io/controller-expand-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-cephfs-node',
      'csi.storage.k8s.io/node-stage-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/fstype': 'ext4',
    }, requiredParams: ['clusterID', 'fsName'] },
  { id: 'openebs-localpv', family: 'distributed', label: 'storage.presets.openebs-localpv.label', hint: 'storage.presets.openebs-localpv.hint',
    provisioner: 'openebs.io/local', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'openebs-localpv',
    parameters: { storageType: 'hostpath' }, requiredParams: [] },
  { id: 'topolvm', family: 'distributed', label: 'storage.presets.topolvm.label', hint: 'storage.presets.topolvm.hint',
    provisioner: 'topolvm.io', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'topolvm',
    parameters: { 'csi.storage.k8s.io/fstype': 'xfs' }, requiredParams: [] },
  // === NFS ===
  { id: 'nfs-csi', family: 'nfs', label: 'storage.presets.nfs-csi.label', hint: 'storage.presets.nfs-csi.hint',
    provisioner: 'nfs.csi.k8s.io', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'nfs-client',
    parameters: { server: '<IP>', share: '</exported/path>', 'csi.storage.k8s.io/fstype': 'nfs' },
    requiredParams: ['server', 'share'] },
  { id: 'nfs-in-tree', family: 'nfs', label: 'storage.presets.nfs-in-tree.label', hint: 'storage.presets.nfs-in-tree.hint',
    provisioner: 'kubernetes.io/nfs', reclaimPolicy: 'Retain', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: false, defaultName: 'nfs',
    parameters: { server: '<IP>', path: '</path>' }, requiredParams: ['server', 'path'] },
  // === 云厂商块存储 ===
  { id: 'aws-ebs', family: 'cloud', label: 'storage.presets.aws-ebs.label', hint: 'storage.presets.aws-ebs.hint',
    provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'ebs-sc',
    parameters: { type: 'gp3', 'csi.storage.k8s.io/fstype': 'ext4' }, requiredParams: [] },
  { id: 'gce-pd', family: 'cloud', label: 'storage.presets.gce-pd.label', hint: 'storage.presets.gce-pd.hint',
    provisioner: 'pd.csi.storage.gke.io', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'standard',
    parameters: { type: 'pd-ssd' }, requiredParams: [] },
  { id: 'azure-disk', family: 'cloud', label: 'storage.presets.azure-disk.label', hint: 'storage.presets.azure-disk.hint',
    provisioner: 'disk.csi.azure.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'disk-sc',
    parameters: { skuName: 'StandardSSD_LRS', 'csi.storage.k8s.io/fstype': 'ext4' }, requiredParams: [] },
  { id: 'aliyun-disk', family: 'cloud', label: 'storage.presets.aliyun-disk.label', hint: 'storage.presets.aliyun-disk.hint',
    provisioner: 'disk.csi.alibabacloud.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'alicloud-disk',
    parameters: { type: 'cloud_essd' }, requiredParams: [] },
  { id: 'tencent-cbs', family: 'cloud', label: 'storage.presets.tencent-cbs.label', hint: 'storage.presets.tencent-cbs.hint',
    provisioner: 'com.tencent.cloud.csi.cbs', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'cbs',
    parameters: { type: 'CLOUD_SSD' }, requiredParams: [] },
  { id: 'huawei-evs', family: 'cloud', label: 'storage.presets.huawei-evs.label', hint: 'storage.presets.huawei-evs.hint',
    provisioner: 'ebs.csi.huaweicloud.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'evs',
    parameters: { 'csi.storage.k8s.io/fstype': 'ext4' }, requiredParams: [] },
]

export const STORAGE_CLASS_PRESET_FAMILIES = [
  { key: 'local', labelKey: 'storage.familyLocal' },
  { key: 'distributed', labelKey: 'storage.familyDistributed' },
  { key: 'nfs', labelKey: 'storage.familyNfs' },
  { key: 'cloud', labelKey: 'storage.familyCloud' },
]

export function paramsMapToRows(map = {}) {
  return Object.entries(map).map(([key, value]) => ({ key, value: String(value) }))
}

export function paramsRowsToMap(rows = []) {
  const map = {}
  for (const r of rows) {
    const k = (r?.key || '').trim()
    if (k) map[k] = r?.value ?? ''
  }
  return map
}

// 接受 rows [{key,value}] / 对象 map / 旧逗号串 "k=v,k=v";统一输出有序 map。
export function normalizeParamsToMap(parameters) {
  if (!parameters) return {}
  if (Array.isArray(parameters)) return paramsRowsToMap(parameters)
  if (typeof parameters === 'string') {
    const map = {}
    for (const kv of parameters.split(',')) {
      const idx = kv.indexOf('=')
      if (idx > 0) map[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim()
    }
    return map
  }
  return { ...parameters }
}

// 任一 requiredParams 的 value 仍含 <...> 占位符 → true(创建弹窗据此阻断)。
export function hasPlaceholderParam(rows, requiredParams = []) {
  const map = paramsRowsToMap(rows)
  return requiredParams.some(k => /<[^\n>]*>/.test(String(map[k] ?? '')))
}

export function presetToFormState(preset) {
  return {
    name: preset.defaultName || '',
    provisioner: preset.provisioner || '',
    parameters: paramsMapToRows(preset.parameters || {}),
    reclaimPolicy: preset.reclaimPolicy || 'Delete',
    volumeBindingMode: preset.volumeBindingMode || 'WaitForFirstConsumer',
    allowVolumeExpansion: !!preset.allowVolumeExpansion,
    default: false,
  }
}
