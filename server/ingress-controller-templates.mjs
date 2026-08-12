// server/ingress-controller-templates.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INGRESS_CONTROLLER_TEMPLATES, findControllerTemplate } from './manifests/ingress-controllers/catalog.mjs'

const MANIFEST_DIR = join(import.meta.dirname, 'manifests', 'ingress-controllers')

// 给前端用:剥离 file 内部字段
export function listControllerTemplates() {
  return INGRESS_CONTROLLER_TEMPLATES.map(({ file, ...rest }) => rest)
}

export function readControllerManifest(id) {
  const t = findControllerTemplate(id)
  if (!t) throw new Error(`未知 ingress 控制器模板: ${id}`)
  return readFileSync(join(MANIFEST_DIR, t.file), 'utf8')
}
