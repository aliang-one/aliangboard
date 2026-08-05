# Ingress 注解 key 自动补全

- 日期：2026-08-05
- 分支：`feat/ingress-anno-complete`（从 `main` @ 126484c 切出）
- 范围：`src/components/common/TypeaheadInput.vue`（新建）、`src/composables/useIngressPerf.js`、`src/views/NsIngress.vue`、`src/views/NsIngressDetail.vue`。

## 背景
创建/编辑 Ingress 时，自定义注解 key 是纯文本输入，用户须记住完整 key（如 `nginx.ingress.kubernetes.io/rewrite-target`）。需补全：输入时弹出常见注解建议，可快速选也可继续手输。

## 设计
### 新组件 TypeaheadInput.vue（通用 typeahead）
- 自定义下拉面板（沿用 EnvSourceField 的应用主题样式，**不用**原生 datalist——暗色模式黑弹层）。
- props：`modelValue`(v-model string)、`options`(string[] | {value,label,desc}[])、`placeholder`、`inputClass`。
- 行为：输入即过滤（按 value/label includes）；点选回填；手输任意值始终允许；点外部关闭（document mousedown）。
- 可复用于未来其它 typeahead 场景。

### 种子建议 INGRESS_ANNOTATION_SUGGESTIONS（useIngressPerf.js）
~28 条常见 Ingress 注解，nginx-ingress 为主 + cert-manager/acme 几条。每条 `{value: 完整key, desc: 中文简述}`。下拉显示「key — desc」。

### 集成（仅 key 字段；value 保持自由文本）
- 创建（NsIngress.vue 自定义注解行的 key `<input>`）→ 换成 `<TypeaheadInput>`。
- 编辑（NsIngressDetail.vue 添加注解弹窗的 key `<input>`）→ 换成 `<TypeaheadInput>`。

## 不做（YAGNI）
value 自动补全（已知值集合，如 ssl-redirect:true/false）——后续可加；本次只做 key。
历史注解建议（从同 ns 已有 Ingress 收集）——后续可加。

## 验证
typecheck + build 通过；人工：创建/编辑 Ingress 注解 key 框 → 输入时弹出建议、可点选、可手输。
