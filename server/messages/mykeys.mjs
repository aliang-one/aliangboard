export const TABLE = {
  'mykeys.namespaceRequired': { zh: '缺少绑定的 namespace', en: 'Namespace is required' },
  'mykeys.clusterRequired': { zh: '缺少集群', en: 'Cluster is required' },
  'mykeys.tierInvalid': { zh: '令牌档位仅支持 read / operator', en: 'Tier must be read or operator' },
  'mykeys.clusterForbidden': { zh: '该集群未分配给你', en: 'This cluster is not assigned to you' },
  'mykeys.ttlInvalid': { zh: '有效期须在 1-{max} 天内', en: 'TTL must be between 1 and {max} days' },
  'mykeys.provisionUnavailable': { zh: '集群身份供给组件不可用', en: 'Cluster identity provisioning is unavailable' },
  'mykeys.provisionFailed': { zh: '集群身份供给失败:{reason}', en: 'Cluster identity provisioning failed: {reason}' },
  'mykeys.keyNotFound': { zh: '令牌不存在或不属于你', en: 'Token not found or not yours' },
  'mykeys.mintFailed': { zh: '签发失败', en: 'Failed to create token' },
  'mykeys.unknownError': { zh: '未知错误', en: 'unknown error' },
}
