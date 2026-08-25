// Secret 创建类型单一事实源：固定字段/必填校验/数据组装（自 NsSecrets.vue 内联 switch 抽出，5 类型零行为变更）
export const SECRET_TYPES = [
  { id: 'Opaque', labelKey: 'ns.secrets.typeOpaque', freeKeys: true },
  { id: 'kubernetes.io/basic-auth', labelKey: 'ns.secrets.typeBasicAuth', fields: [
    { key: 'username', labelKey: 'component.createConfigModal.fUsername', multiline: false },
    { key: 'password', labelKey: 'component.createConfigModal.fPassword', multiline: false, secret: true },
  ] },
  { id: 'kubernetes.io/dockerconfigjson', labelKey: 'ns.secrets.typeDocker', fields: [
    { key: 'registry', labelKey: 'component.createConfigModal.fRegistry', multiline: false },
    { key: 'registryUser', labelKey: 'component.createConfigModal.fRegistryUser', multiline: false },
    { key: 'registryPassword', labelKey: 'component.createConfigModal.fRegistryPassword', multiline: false, secret: true },
    { key: 'registryEmail', labelKey: 'component.createConfigModal.fRegistryEmail', multiline: false },
  ] },
  { id: 'kubernetes.io/tls', labelKey: 'ns.secrets.typeTls', fields: [
    { key: 'tls.crt', labelKey: 'component.createConfigModal.fTlsCrt', multiline: true },
    { key: 'tls.key', labelKey: 'component.createConfigModal.fTlsKey', multiline: true, secret: true },
  ] },
  { id: 'kubernetes.io/ssh-auth', labelKey: 'ns.secrets.typeSsh', fields: [
    { key: 'ssh-privatekey', labelKey: 'component.createConfigModal.fSshKey', multiline: true, secret: true },
  ] },
]

export function buildSecretData(typeId, values) {
  if (typeId === 'Opaque') return { ...(values.data || {}) }
  if (typeId === 'kubernetes.io/basic-auth') return { username: values.username || '', password: values.password || '' }
  if (typeId === 'kubernetes.io/dockerconfigjson') {
    let auth = ''
    try { auth = btoa(`${values.registryUser}:${values.registryPassword}`) } catch { auth = `${values.registryUser}:${values.registryPassword}` }
    const cfg = { auths: { [values.registry]: { username: values.registryUser, password: values.registryPassword, email: values.registryEmail, auth } } }
    return { '.dockerconfigjson': JSON.stringify(cfg) }
  }
  if (typeId === 'kubernetes.io/tls') return { 'tls.crt': values['tls.crt'] || '', 'tls.key': values['tls.key'] || '' }
  if (typeId === 'kubernetes.io/ssh-auth') return { 'ssh-privatekey': values['ssh-privatekey'] || '' }
  return {}
}

export function secretFieldsComplete(typeId, values) {
  switch (typeId) {
    case 'kubernetes.io/basic-auth': return !!(values.username && values.password)
    case 'kubernetes.io/dockerconfigjson': return !!(values.registry && values.registryUser && values.registryPassword)
    case 'kubernetes.io/tls': return !!(values['tls.crt'] && values['tls.key'])
    case 'kubernetes.io/ssh-auth': return !!values['ssh-privatekey']
    default: return Object.keys(values.data || {}).length > 0
  }
}
