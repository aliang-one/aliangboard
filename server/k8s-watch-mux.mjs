// K8s watch 多路复用（网关侧纯逻辑）：
// 浏览器对同源 HTTP/1.1 并发连接 ~6 上限，前端 7 条常驻 watch 会饿死所有 /api 请求。
// 此模块把 7 类资源 watch 聚合成单条 NDJSON 流：每行 { r: 资源, t: 事件类型, o: 对象 }；
// 任一上游失败则整条通道关闭（写 { r, err } 行），由浏览器驱动 relist+重连。
// index.mjs 注入 fetchUpstream/write/end —— 凭据与 URL 构建复用既有流式透传分支。

// 资源 → 上游 watch 路径 白名单（集群级全量 watch，ns 过滤由 K8s 服务端 fieldSelector 由前端追加）
export const WATCH_RESOURCES = {
  pods: '/api/v1/pods',
  events: '/api/v1/events',
  deployments: '/apis/apps/v1/deployments',
  statefulsets: '/apis/apps/v1/statefulsets',
  daemonsets: '/apis/apps/v1/daemonsets',
  services: '/api/v1/services',
  ingresses: '/apis/networking.k8s.io/v1/ingresses',
}

// 解析 ?resources=pods,events&rv_<r>=<rv>：合法项进 list（带上游 path+起始 rv），未知项进 invalid
export function parseResources(urlOrParams) {
  const query = urlOrParams?.searchParams ?? urlOrParams // 兼容 URL / URLSearchParams
  const raw = String(query.get('resources') || '')
  const names = raw.split(',').map(s => s.trim()).filter(Boolean)
  const list = []
  const invalid = []
  for (const name of names) {
    const path = WATCH_RESOURCES[name]
    if (!path) { invalid.push(name); continue }
    list.push({ resource: name, path, rv: query.get(`rv_${name}`) || undefined })
  }
  return { list, invalid }
}

// 把一条上游 NDJSON watch 行打上资源标签；非 JSON/空行（心跳等）返 null 跳过
export function tagLine(resource, line) {
  const s = String(line || '').trim()
  if (!s) return null
  let evt
  try { evt = JSON.parse(s) } catch { return null }
  if (!evt || typeof evt !== 'object' || !evt.type) return null
  return JSON.stringify({ r: resource, t: evt.type, o: evt.object })
}

// 逐行读异步 body（string/Uint8Array 分帧按 \n 切）
async function* linesOf(body) {
  let buf = ''
  const decoder = new TextDecoder()
  const reader = body.getReader ? body.getReader() : null
  const source = reader
    ? (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) break; yield value } })()
    : body
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
    }
  }
  if (buf.trim()) yield buf
}

// 创建多路复用流。resources 为 parseResources().list；fetchUpstream(path, { signal}) → { ok, status, body }。
// 返回 { close, done }：close() 中止全部上游；done 在通道终结（end() 已调用）后 resolve。
export function createMuxStream({ fetchUpstream, resources, write, end }) {
  const shared = new AbortController() // close()/单路上游失败统一打这里
  let ended = false
  const finish = () => {
    if (ended) return
    ended = true
    try { shared.abort() } catch { /* noop */ }
    end()
  }
  const pump = async ({ resource, path, rv }) => {
    const qs = rv ? `?watch=true&resourceVersion=${encodeURIComponent(rv)}` : '?watch=true'
    try {
      const resp = await fetchUpstream(path + qs, { signal: shared.signal })
      if (!resp.ok) {
        write(JSON.stringify({ r: resource, err: resp.status || 0 }))
        finish() // 单通道失败 → 整条关闭，浏览器 relist+重连
        return
      }
      for await (const line of linesOf(resp.body)) {
        if (ended) return
        const tagged = tagLine(resource, line)
        if (tagged !== null) write(tagged)
      }
    } catch {
      // 读错误/abort：abort 触发的 finish 已在别处调过则跳过
      if (!ended) {
        write(JSON.stringify({ r: resource, err: 0 }))
        finish()
      }
      return
    }
  }
  const all = Promise.all(resources.map(pump)).then(finish) // 全部正常结束 → end
  return {
    close: () => finish(),
    done: all,
  }
}
