// routes/credentials.mjs 的用户可见消息（双语表,格式同 wbp.mjs）
export const TABLE = {
  'wcred.notFound': { zh: '凭据不存在', en: 'Credential not found' },
  'wcred.createFailed': { zh: '创建失败', en: 'Failed to create' },
  'wcred.updateFailed': { zh: '更新失败', en: 'Failed to update' },
  'wcred.deleteFailed': { zh: '删除失败', en: 'Failed to delete' },
  'wcred.confirmNameMismatch': { zh: '确认名与凭据名不一致', en: 'Confirm name does not match' },
  'wcred.fieldNotFound': { zh: '字段不存在', en: 'Field not found' },
  'wcred.decryptFailed': { zh: '解密失败,请重新录入该凭据', en: 'Decrypt failed, please re-enter this credential' },
  'wcred.methodNotAllowed': { zh: 'method not allowed', en: 'method not allowed' },
}
