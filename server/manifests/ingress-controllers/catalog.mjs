// server/manifests/ingress-controllers/catalog.mjs
// 部署 Ingress 控制器的官方清单目录(打包静态资产)。清单 <id>.yaml 从官方钉版本拉取,
// catalog 记元数据。纯 ES 模块:server/ingress-controller-templates.mjs 与 server *.test.mjs 均可直 import。
export const INGRESS_CONTROLLER_TEMPLATES = [
  {
    id: 'nginx-ingress',
    labelKey: 'ingressController.nginx-ingress.label',
    descKey: 'ingressController.nginx-ingress.desc',
    notesKey: 'ingressController.nginx-ingress.notes',
    version: 'controller-v1.12.1',                 // 与上方拉取 tag 一致
    source: 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/baremetal/deploy.yaml',
    variant: 'bare-metal NodePort',
    controller: 'k8s.io/ingress-nginx',            // 必须等于清单内 IngressClass.spec.controller
    defaultClassName: 'nginx',
    file: 'nginx-ingress.yaml',
  },
  {
    id: 'haproxy',
    labelKey: 'ingressController.haproxy.label',
    descKey: 'ingressController.haproxy.desc',
    notesKey: 'ingressController.haproxy.notes',
    version: 'master',                              // examples/rbac 无 release tag,跟踪 master
    source: 'https://raw.githubusercontent.com/jcmoraisjr/haproxy-ingress/master/examples/rbac/ingress-controller-rbac.yml',
    variant: 'RBAC + namespace (示例式安装)',
    controller: 'haproxy-ingress.github.io/controller',  // 必须 = 清单 IngressClass.spec.controller (--controller-class 默认)
    defaultClassName: 'haproxy',
    file: 'haproxy.yaml',
  },
]

export function findControllerTemplate(id) {
  return INGRESS_CONTROLLER_TEMPLATES.find(t => t.id === id) || null
}
