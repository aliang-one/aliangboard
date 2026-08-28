// SSH 管理用户可见消息(zh/en)。条目键见 ssh/routes.mjs 引用。
export const TABLE = {
  'ssh.badInput':      { zh: '参数校验失败:{reason}', en: 'Invalid input: {reason}' },
  'ssh.notFound':      { zh: 'SSH 服务器不存在', en: 'SSH server not found' },
  'ssh.credKeyMissing':{ zh: '凭据密钥不可用(密钥文件丢失或损坏),请重新录入该服务器凭据', en: 'Credential key unavailable (missing or corrupted key file). Please re-enter credentials for this server' },
  'ssh.testUnreachable': { zh: '连接失败:主机不可达或端口未开({kind})', en: 'Connect failed: host unreachable or port closed ({kind})' },
  'ssh.testAuthFailed':  { zh: '连接失败:认证被拒(用户名/密码/密钥错误)', en: 'Connect failed: authentication rejected' },
  'ssh.testHostkey':     { zh: '连接失败:主机密钥与已记录指纹不符(疑似中间人,请在列表页人工确认)', en: 'Connect failed: host key mismatch with recorded fingerprint' },
  'ssh.testOk':          { zh: '连接成功', en: 'Connection OK' },
  'ssh.testGeneric':     { zh: '连接失败:{message}', en: 'Connect failed: {message}' },
  'ssh.created':       { zh: 'SSH 服务器已创建', en: 'SSH server created' },
  'ssh.updated':       { zh: 'SSH 服务器已更新', en: 'SSH server updated' },
  'ssh.deleted':       { zh: 'SSH 服务器已删除', en: 'SSH server deleted' },
  'ssh.forbidden':     { zh: '仅管理员可管理 SSH 服务器', en: 'Only admins can manage SSH servers' },
}
