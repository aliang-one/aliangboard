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
    version: 'v0.16.1',                             // haproxy-ingress app 版本(chart 0.16.1)
    source: 'https://haproxy-ingress.github.io/charts (chart haproxy-ingress/haproxy-ingress@0.16.1)',
    variant: 'helm-rendered bare-metal NodePort',
    controller: 'haproxy-ingress.github.io/controller',  // = 清单 IngressClass.spec.controller(chart --controller-class 默认)
    defaultClassName: 'haproxy',
    file: 'haproxy.yaml',
  },
  {
    id: 'traefik',
    labelKey: 'ingressController.traefik.label',
    descKey: 'ingressController.traefik.desc',
    notesKey: 'ingressController.traefik.notes',
    version: '41.2.0',                              // traefik chart 版本(app v3.7.10)
    source: 'https://traefik.github.io/charts (chart traefik/traefik@41.2.0)',
    variant: 'helm-rendered bare-metal NodePort (IngressClass non-default)',
    controller: 'traefik.io/ingress-controller',   // = 清单 IngressClass.spec.controller(chart 默认 ingressClass.enabled=true)
    defaultClassName: 'traefik',
    file: 'traefik.yaml',
  },
]

export function findControllerTemplate(id) {
  return INGRESS_CONTROLLER_TEMPLATES.find(t => t.id === id) || null
}
