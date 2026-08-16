# Ingress 字段单位选择与格式校验 + 全应用表单审计 — 设计

日期:2026-08-16 | 状态:已批准(方案 A) | 分支:`worktree-feat-ingress-field-units`

## 背景与动机

线上事故 1:`proxy-send-timeout: 3600` 注解值裸写入 YAML 被 apiserver 拒收(int→map[string]string)——已修(`8e67fac`,yamlScalar YAML 1.1 隐式类型化防线)。

线上事故 2(本设计动机):`proxy_buffer_size directive invalid value`——nginx ingress admission webhook 拒绝。根因是 UX:性能面板的数值/大小字段是裸文本框,无单位选择、无格式提示、无校验,错值一路提交到集群才炸,报错还是 nginx 崩溃日志,用户无法定位。

用户规则:**纯数值字段→让用户选择单位;格式受限字段→提示输入格式**。本次修复聚焦 Ingress 面,同时产出全应用表单审计报告,其余视图分批修。

## 方案(已批准 A:元信息驱动 + 共享组件)

字段定义(`useIngressPerf.js`)与渲染本就分离,给字段加值类型元信息 `vt`,同一份元信息驱动**渲染、提示、校验**三层。

## ① 数据模型:字段值类型(`useIngressPerf.js`)

| vt | 输入形态 | 校验 | 覆盖字段(nginx / haproxy / traefik / kong) |
|---|---|---|---|
| `sec` | 数字框 + 只读后缀「秒」 | `/^\d+$/` | proxy-connect/send/read-timeout、hsts-max-age、upstream-keepalive-timeout |
| `count` | 数字框 + 只读后缀(按字段 hint:个 / KB·s) | `/^\d+$/` | limit-connections、limit-rps、limit-burst、limit-rate、upstream-keepalive-connections/requests、maxconn-server(hpx)、regex-priority(kong) |
| `intRange` | 数字框 + min/max | 整数且在区间 | compression-level(1-9) |
| `size` | **数字框 + 单位下拉 k/m/g** | 数字(+单位)组合恒合法 | proxy-body-size、proxy-buffer-size(事故字段) |
| `hpxTime` | 数字框 + 单位下拉 ms/s/m | 组合恒合法 | timeout-connect/server/http-request/queue(hpx,值如 `50s`) |
| `csvInt` | 文本框 + hint「逗号分隔状态码」 | `/^\d+(,\d+)*$/` | custom-http-errors |
| `path` | 文本框 + hint | 须以 `/` 开头 | rewrite-target、app-root |
| `csv` | 文本框 + hint「逗号分隔」 | 非空即过(不过度校验) | methods(kong)、entrypoints/middlewares(traefik) |
| `free` | textarea/text + hint,不校验 | — | server-snippet、configuration-snippet、cors-allow-origin、session-cookie-name |

要点:
- 校验器导出 `validateAdvValue(vt, raw)` → 错误 i18n key 或 null;`validateIngressAdv(dialect, adv)` → `[{key, labelKey, msgKey}][]`
- **`adv` 值仍为规范串**(`'4k'`/`'60'`/`'5s'`),`buildIngressAnnotations` 契约零改动
- `options`(布尔/枚举)与 `area` 现有分支语义保留;`area` 字段视为 `free`
- `vt` 表按方言全量覆盖:nginx 33 字段、haproxy 8、traefik 3、kong 3,一个不漏

## ② 组件:`IngressPerfField.vue`(`src/components/common/`)

仿 `ResourceInput`(既有先例:数字框+单位下拉):

- props:`{ fld, modelValue }`;emit 规范串
- `size`:内部拆合 `'4k'`→`4`+`k`,空串→空;单位下拉 k/m/g(nginx 大小写不敏感,统一小写输出)
- `hpxTime`:数字 + 单位下拉(ms/s/m),默认 s,输出 `50s`;已含单位的存量值可回显拆合
- `sec/count/intRange`:`type=number`(天然挡字母),只读单位后缀;intRange 带 min/max
- `csvInt/csv/path/free`:文本/textarea + hint 文案(常显,字号 text-xs)
- watch `modelValue` 同步外部重填(编辑回显)

## ③ 视图接入:两处重复标记收敛

- `NsIngress.vue:317-324` 与 `DeployApp.vue:1489-1496` 的字段三分支渲染(area/options/input)替换为 `<IngressPerfField :fld="fld" v-model="adv[fld.key]" />`(DeployApp 绑 `form.ingressAdv[fld.key]`),顺手消灭既有复制粘贴

## ④ 注解编辑 3 处:按已知 key 提示/校验

- `INGRESS_ANNOTATION_SUGGESTIONS` 每条扩 `vfmt`(指向 ① 的 vt 表,按注解后缀映射,单一事实源;如 `proxy-send-timeout`→`sec`)
- 生效面:`NsIngress` 自定义注解行、`DeployApp` 自定义注解行、`NsIngressDetail` 添加/编辑注解弹窗
- key 命中已知项 → value 输入下方显示该 key 的格式 hint;保存时按 vfmt 校验
- 未知 key 不限制(任意注解无法穷举),维持现状

## ⑤ 错误处理:提交时拦截(用户选定强度)

- `handleCreate`(NsIngress)、DeployApp 第 5 步提交、`addAnnotation/saveAnn`(NsIngressDetail):发请求前跑校验
- 不合格 → `notify('error', t(msgKey, { field: t(labelKey) }))`,**不关弹窗、不提交、不 invalidate**
- 报错提前到客户端、指名字段——取代 admission webhook 的 nginx 崩溃日志

## ⑥ i18n

新增键全部在 `ingressPerf.*` 命名空间:单位后缀(unitSeconds/unitCount/unitKbs)、各 vt hint、错误文案(errNotNumber/errRange/errCsvInt/errPath 等),zh/en 同步;过 `npm run i18n:check`。

## ⑦ 测试与审计交付

测试(vitest):
- 校验器真相表:每 vt 的合法/非法样例(含空串=跳过、`'4k'` 合法、`'4kb'` 非法、`'404,503'` 合法、`'404,x'` 非法…)
- `IngressPerfField` 组件:size 渲染出单位下拉、`'4k'`↔4+k 拆合、emit 规范串、外部重填同步
- NsIngress 创建流程:非法值被拦截(toast 调用 + applyYaml 未调)
- 既有 `NsIngress.dialect.test.js`、`DeployIngressControllerDialog` 等回归不受影响

审计交付:`docs/form-field-audit-2026-08-16.md`
- 实现阶段系统性扫全部视图的输入字段(资源量类/数字类/格式受限类/自由文本类)
- 按「纯数值→单位选择 / 格式受限→提示 / 已合规 / 自由文本不适用」分类列表
- Ingress 面记为已修;其余按风险(有没有远端校验兜底、错值后果)排 backlog

## 非目标(YAGNI)

- 不改 `buildIngressAnnotations` 输出契约;不动 yamlScalar(上一事故已修)
- 不实时红框校验(用户已选「提示+提交拦截」)
- 不给未知注解 key 做 value 校验;不覆盖 Ingress 之外的视图修复(只审计报告)
- snippet 类不做 nginx 语法校验
