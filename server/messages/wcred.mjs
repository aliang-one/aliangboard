// routes/credentials.mjs 的用户可见消息（双语表,格式同 wbp.mjs）
export const TABLE = {
  'wcred.notFound': { zh: '凭据不存在', en: 'Credential not found' },
  'wcred.createFailed': { zh: '创建失败', en: 'Failed to create' },
  'wcred.loadFailed': { zh: '读取失败', en: 'Failed to load' },
  'wcred.updateFailed': { zh: '更新失败', en: 'Failed to update' },
  'wcred.deleteFailed': { zh: '删除失败', en: 'Failed to delete' },
  'wcred.confirmNameMismatch': { zh: '确认名与凭据名不一致', en: 'Confirm name does not match' },
  'wcred.fieldNotFound': { zh: '字段不存在', en: 'Field not found' },
  'wcred.decryptFailed': { zh: '解密失败,请重新录入该凭据', en: 'Decrypt failed, please re-enter this credential' },
  'wcred.methodNotAllowed': { zh: 'method not allowed', en: 'method not allowed' },
  'wcred.llmNotConfigured': { zh: 'LLM 未配置,请管理员在「LLM 配置」设置 baseURL/model 后重试', en: 'LLM not configured; ask admin to set baseURL/model first' },
  'wcred.parseFailed': { zh: '解析失败,请重试或改用手动录入', en: 'Parse failed; retry or enter manually' },
  'wcred.unknownAdapter': { zh: '未知适配器', en: 'Unknown adapter' },
}
