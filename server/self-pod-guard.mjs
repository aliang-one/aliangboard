// server/self-pod-guard.mjs
// 自指容器防线(2026-10-24 凭据审计 P0-2,边界面最大缺口):工作台 AI 的免审原语
// (wb_read_pod_file requiresApproval:false——任何审批档直行;wb_exec 在 auto 档免审)可指向
// 网关自身容器——cred-crypt.key/ssh-crypt.key 主钥与 SQLite 都在那,读回内容不经过任何已知
// 值洗涤直达 LLM 上下文,落库加密/审批门/往返双洗对这条通路零防御。整个「AI 不见明文」体系
// 在「AI 可执行工作台」部署形态下被这一个通路归零,故在工具执行面收口:
//   ① pod 名识别:K8s 容器 hostname=pod 名(kubelet 注入,与 downward API 同源可信);
//   ② 敏感路径 belt:库文件与两把主钥的绝对路径精确拒绝(HOSTNAME 不可用的环境仍拦读文件面;
//     exec 命令面无法路径级拦(cat/base64/重定向组合无限),pod 名识别是 exec 主防线)。
// 非 K8s 本地 dev(HOSTNAME 缺失)pod 判定 fail-open——路径 belt 仍在。纯函数,env 注入可单测。
const MIN_POD_LEN = 3

export function selfPodName(env = process.env) {
  return env.HOSTNAME || ''
}

export function isSelfPodTarget(pod, env = process.env) {
  const own = selfPodName(env)
  if (!own || own.length < MIN_POD_LEN) return false
  return String(pod || '') === own
}

// 网关数据面文件清单:ALIANG_DB 派生(库 + 同目录两把主钥,index.mjs loadOrCreateKey 同源)。
export function sensitiveGatewayPaths(env = process.env) {
  const db = env.ALIANG_DB
  if (!db) return []
  const dir = db.slice(0, db.lastIndexOf('/'))
  return [db, `${dir}/cred-crypt.key`, `${dir}/ssh-crypt.key`]
}

export function isSensitiveGatewayPath(p, env = process.env) {
  const s = String(p || '')
  if (!s) return false
  return sensitiveGatewayPaths(env).includes(s)
}
