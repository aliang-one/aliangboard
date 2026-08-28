// routes/auth.mjs 的用户可见消息（zh 与原文逐字一致，既有测试断言依赖）
export const TABLE = {
  'auth.emptyCredentials': { zh: '用户名和密码不能为空', en: 'Username and password are required' },
  'auth.badCredentials': { zh: '用户名或密码错误', en: 'Invalid username or password' },
  'auth.rateLimited': { zh: '尝试过于频繁,请稍后再试', en: 'Too many attempts, please retry later' },
  'auth.loginFailed': { zh: '登录失败', en: 'Login failed' },
  'auth.clusterNotFound': { zh: '集群不存在', en: 'Cluster not found' },
  'auth.clusterForbidden': { zh: '无权访问此集群', en: 'No access to this cluster' },
  'auth.connectFailed': { zh: '连接集群失败', en: 'Failed to connect to the cluster' },
}
