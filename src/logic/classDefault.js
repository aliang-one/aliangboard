// src/logic/classDefault.js —— 集群级「默认类」单源语义(2026-09-04 集群默认不变式,spec §3.1)。
// 不变式:「集群默认」选项仅当集群存在被标记默认的类才可选;落库用显式默认类名,不写空值。
// 两域 mapper 字段名不同:IngressClass=isDefault,StorageClass=default → key 参数化。
export function findDefaultClass(classes, key = 'isDefault') {
  return (classes || []).find(c => c && c[key]) || null
}
export function canUseClusterDefault(classes, key = 'isDefault') {
  return !!findDefaultClass(classes, key)
}
export function resolveClusterDefaultName(classes, key = 'isDefault') {
  return findDefaultClass(classes, key)?.name || ''
}
