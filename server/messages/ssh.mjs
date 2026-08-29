// SSH 管理用户可见消息(zh/en)。条目键见 ssh/routes.mjs 引用。
export const TABLE = {
  'ssh.badInput':      { zh: '参数校验失败:{reason}', en: 'Invalid input: {reason}' },
  'ssh.notFound':      { zh: 'SSH 服务器不存在', en: 'SSH server not found' },
  'ssh.credKeyMissing':{ zh: '凭据密钥不可用(密钥文件丢失或损坏),请重新录入该服务器凭据', en: 'Credential key unavailable (missing or corrupted key file). Please re-enter credentials for this server' },
  'ssh.testUnreachable': { zh: '连接失败:主机不可达或端口未开({kind})', en: 'Connect failed: host unreachable or port closed ({kind})' },
  'ssh.testAuthFailed':  { zh: '连接失败:认证被拒(用户名/密码/密钥错误)', en: 'Connect failed: authentication rejected' },
  'ssh.testHostkey':     { zh: '连接失败:主机密钥与已记录指纹不符(服务器可能重装过系统/换过密钥,也可能遭遇中间人攻击,请人工确认)', en: 'Connect failed: host key mismatch with recorded fingerprint (server may have been reinstalled/rekeyed, or this is a possible MITM — confirm manually)' },
  'ssh.testOk':          { zh: '连接成功', en: 'Connection OK' },
  'ssh.testGeneric':     { zh: '连接失败:{message}', en: 'Connect failed: {message}' },
  'ssh.created':       { zh: 'SSH 服务器已创建', en: 'SSH server created' },
  'ssh.updated':       { zh: 'SSH 服务器已更新', en: 'SSH server updated' },
  'ssh.deleted':       { zh: 'SSH 服务器已删除', en: 'SSH server deleted' },
  'ssh.sessionNotFound': { zh: '终端会话不存在或已结束', en: 'Terminal session not found or already ended' },
  'ssh.sessionKilled':   { zh: '终端会话已终止', en: 'Terminal session terminated' },
  'ssh.reapedAttached':   { zh: '会话因长时间无活动被策略关闭', en: 'Session closed by policy after inactivity' },
  'ssh.reapedMaxLifetime':{ zh: '会话达到最长存活时间,被策略关闭', en: 'Session closed by max-lifetime policy' },
}
