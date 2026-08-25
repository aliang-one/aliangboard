// 镜像串 → DNS-1123 容器名基名(纯字符串变换)。单一事实源:
// DeployApp YAML 生成 derivedContainerName 与 ContainerEditorDialog「自动命名预览」共用。
// K8s 容器名 ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$——registry 前缀/大写/下划线/点会被拒,
// 故取最后一段路径去掉 :tag,小写化,非法字符折叠成 '-',去首尾与重复 '-',截 63。
// 返回值可能为空串(image 为空/全非法)——fallback 与撞名去重(-2/-3)由调用方决定。
export function sanitizeImageToName(image) {
  return String(image || '')
    .split('/').pop().split(':')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}
