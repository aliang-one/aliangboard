// src/logic/ingressClass.js —— IngressClass 具体类选择(2026-09-01「集群默认」概念退役)
//
// 背景:创建 Ingress 的三个入口(NsIngress 弹窗 / DeployApp 向导 / 拓扑连线)曾默认 className='',
// 生成 YAML 不写 ingressClassName,指望 API server 按集群默认类(is-default-class 注解)默认化;
// 但集群经常没有任何被标记默认的类(平台自带的 4 份控制器清单全部刻意不标,kong 注释明确「避免双 claim」)
// → Ingress 落地成「无类」,控制器(如 ingress-nginx 默认只 watch 自己的类)不接 → 永远没有 ADDRESS。
// 修法:落库前总是选中一个确定的类,不再依赖集群侧默认化。
//
// 选择规则:isDefault 标记的类优先(写明值,与集群默认化语义等价但确定可见);
// 否则取字母序第一(不依赖接口返回顺序);无类返回 ''(调用方回退「集群无 IngressClass」)。
export function pickIngressClassName(classes) {
  const list = (classes || []).filter(c => c && c.name)
  if (!list.length) return ''
  const def = list.find(c => c.isDefault)
  if (def) return def.name
  return list.map(c => c.name).sort()[0]
}
