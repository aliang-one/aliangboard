// Ingress 控制器模板目录/清单 HTTP 端点(平台内置静态资产,不需 K8s session;
// 清单 apply 仍走需 session 的 /api/apply)。handler/dispatcher 模式,同 auth.mjs。
// (自 index.mjs 内联迁入 — 2026-08 合并 worktree-feat+next 时对齐路由模块化重构。)
import { listControllerTemplates, readControllerManifest } from '../ingress-controller-templates.mjs'

export function createIngressControllerRoutes({ sendJson }) {
  // 匹配则处理并返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/ingress-controllers/catalog') {
      sendJson(res, 200, { templates: listControllerTemplates() })
      return true
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/ingress-controllers/manifest/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/ingress-controllers/manifest/'.length))
      try {
        sendJson(res, 200, { yaml: readControllerManifest(id) })
      } catch (e) {
        sendJson(res, 404, { message: e?.message || '未知模板' })
      }
      return true
    }
    return false
  }
  return { handle }
}
