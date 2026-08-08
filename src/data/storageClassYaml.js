// StorageClass YAML 构造纯函数。无 Vue 依赖,便于 scripts/test.mjs 直接 import。
// cluster.js 的 generateYAML('storageclass') 委托本函数;Storage.vue 预览经 store.generateYAML 间接复用。
import { normalizeParamsToMap } from './storageClassPresets.js'

export function buildStorageClassYaml(resource = {}) {
  const name = resource.name || resource.metadata?.name || 'unnamed'
  const provisioner = resource.provisioner || 'kubernetes.io/no-provisioner'
  const reclaimPolicy = resource.reclaimPolicy || 'Delete'
  const volumeBindingMode = resource.volumeBindingMode || 'WaitForFirstConsumer'
  const params = normalizeParamsToMap(resource.parameters)
  const paramKeys = Object.keys(params)
  const paramsYaml = paramKeys.length
    ? paramKeys.map(k => `    ${k}: ${params[k]}`).join('\n')
    : '    {}'

  const lines = [
    'apiVersion: storage.k8s.io/v1',
    'kind: StorageClass',
    'metadata:',
    `  name: ${name}`,
  ]
  if (resource.default === true) {
    lines.push('  annotations:')
    lines.push('    storageclass.kubernetes.io/is-default-class: "true"')
  }
  lines.push(
    `provisioner: ${provisioner}`,
    `reclaimPolicy: ${reclaimPolicy}`,
    `volumeBindingMode: ${volumeBindingMode}`,
  )
  if (resource.allowVolumeExpansion === true) lines.push('allowVolumeExpansion: true')
  if (Array.isArray(resource.mountOptions) && resource.mountOptions.length) {
    lines.push('mountOptions:')
    for (const o of resource.mountOptions) lines.push(`  - ${o}`)
  }
  lines.push('parameters:')
  lines.push(paramsYaml)
  return lines.join('\n')
}
