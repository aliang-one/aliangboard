// YAML apply 内核(2026-08-28 自 index.mjs 抽出,全资源 YAML 创建):
// /api/apply 与工作台(applyYamlPartial)共用;deps 注入便于单测(api-key-tools 同款模式)。
// ns 缺省链:显式 metadata.namespace > defaultNs > 'default';集群级 kind 忽略后两者
// (namespaced 来自集群 discovery,权威且对 CRD 正确)。
import { loadAll as yamlLoadAll } from 'js-yaml'

// ns 解析单一事实源(applyYaml/applyYamlPartial 与 /api/apply 授权门共用;禁止各自内联 || 链,防漂移):
// 显式 metadata.namespace > defaultNs > 'default';集群级 kind(discovery namespaced=false)返回 undefined。
export function resolveApplyNamespace(object, resource, defaultNs) {
  if (!resource.namespaced) return undefined
  return object.metadata.namespace || defaultNs || 'default'
}

// 逐文档解析 ns(/api/apply 授权门用;resolveApplyNamespace 的批量形态,单一同源):
// resourceFor(object, index) 回 discovery 资源项(namespaced 字段)或 null(不可发现)。
// 返回逐文档:string=该 ns 需 operate 门;undefined=集群级 kind(null-ns 门);null=不可发现
// (缺 kind/apiVersion 或集群未收录)→ 调用方跳过,applyYaml 以原语义失败。
export function applyDocNamespaces(objects, defaultNs, resourceFor) {
  return (objects || []).map((object, i) => {
    const resource = resourceFor(object, i)
    return resource ? resolveApplyNamespace(object, resource, defaultNs) : null
  })
}

export function createApplyYaml({ requestKubernetes }) {
  const discoveryCache = new Map() // apiServer:apiVersion → resources[]

  async function discoverResource(session, object) {
    const apiVersion = String(object.apiVersion || '')
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/', 2) : ['', apiVersion]
    if (!version) throw new Error('YAML 缺少 apiVersion')
    const cacheKey = `${session.apiServer}:${apiVersion}`
    let resources = discoveryCache.get(cacheKey)
    if (!resources) {
      const discoveryPath = group ? `/apis/${group}/${version}` : `/api/${version}`
      resources = (await requestKubernetes(session, discoveryPath)).body?.resources || []
      discoveryCache.set(cacheKey, resources)
    }
    const resource = resources.find(item => item.kind === object.kind && !item.name.includes('/'))
    if (!resource) throw new Error(`集群未发现资源类型 ${object.kind} (${apiVersion})`)
    return { group, version, resource }
  }

  async function applyObjects(session, yaml, defaultNs, { keepBody }) {
    const objects = []
    yamlLoadAll(yaml, object => { if (object) objects.push(object) })
    // 仅 applyYaml(keepBody=true,/api/apply)空 yaml 抛错 → handler catch 回 422;
    // applyYamlPartial(工作台)空 yaml 不抛,回 { applied:[], failed:[], total:0 }。
    if (keepBody && !objects.length) throw new Error('YAML 中没有可应用的资源')
    const resources = [], applied = [], failed = []
    for (const object of objects) {
      const label = { kind: object?.kind, name: object?.metadata?.name }
      try {
        if (!object?.kind || !object?.metadata?.name) throw new Error('YAML 缺少 kind 或 metadata.name')
        const { group, version, resource } = await discoverResource(session, object)
        const ns = resolveApplyNamespace(object, resource, defaultNs)
        label.namespace = ns
        const prefix = group ? `/apis/${group}/${version}` : `/api/${version}`
        const namespacePart = ns !== undefined ? `/namespaces/${encodeURIComponent(ns)}` : ''
        const path = `${prefix}${namespacePart}/${resource.name}/${encodeURIComponent(object.metadata.name)}?fieldManager=aliangboard&force=true`
        const result = await requestKubernetes(session, path, {
          method: 'PATCH',
          headers: { 'content-type': 'application/apply-patch+yaml' },
          body: JSON.stringify(object),
        })
        if (keepBody) resources.push(result.body)
        applied.push(label)
      } catch (e) { failed.push({ ...label, error: e.message }) }
    }
    return keepBody ? { resources, applied, failed, total: objects.length } : { applied, failed, total: objects.length }
  }

  // /api/apply 用:逐资源 try/catch(多文档先建的不被后建失败连累),回 body。
  async function applyYaml(session, yaml, defaultNs) {
    return applyObjects(session, yaml, defaultNs, { keepBody: true })
  }
  // 工作台用(W5):同样逐资源 try/catch,只回 label 不要 body。
  async function applyYamlPartial(session, yaml, defaultNs) {
    return applyObjects(session, yaml, defaultNs, { keepBody: false })
  }

  // /api/apply 授权门(评审 R1)预检:每个 doc 走同一 discovery + resolveApplyNamespace,
  // 回每文档解析 ns(undefined=集群级 kind,null=不可发现——apply 时按原语义失败,门不拦)。
  // discovery 结果进 instance 缓存,紧随的 applyYaml 不重复上游调用。
  async function resolveApplyNamespaces(session, yaml, defaultNs) {
    const objects = []
    yamlLoadAll(yaml, object => { if (object) objects.push(object) })
    const resources = []
    for (const object of objects) {
      try { resources.push((await discoverResource(session, object)).resource) }
      catch { resources.push(null) } // 不可发现:applyYaml 会以原语义报错
    }
    return applyDocNamespaces(objects, defaultNs, (_o, i) => resources[i])
  }

  return { applyYaml, applyYamlPartial, resolveApplyNamespaces }
}
