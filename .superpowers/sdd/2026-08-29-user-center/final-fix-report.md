
# 终审统一修复波次(2026-08-29)

单提交覆盖 5 个终审发现,全量门禁绿。

## 发现 1:暗色首帧白闪
- 改动:`src/styles/main.css` 顶部(tailwind 指令后)加 `:root { color-scheme: light; }` 与 `html.dark { color-scheme: dark; }`,附 rationale 注释。
- 证据:`npm run build` 产物 `dist/assets/index-aQ5MwTVb.css` 含 `color-scheme:dark`(grep 实证);UA 画布/滚动条/表单控件随 html.dark 翻深,JS 注入 palette 变量前的 token invalid 由深画布兜底。

## 发现 2:createdAt 不下发
- 改动:`server/routes/auth.mjs` 三处——login 成功 user 对象加 `createdAt: user.createdAt`;GET/PATCH /api/auth/me 的 SELECT 均补 `,createdAt`。
- 证据:新增测试「GET /api/auth/me:响应 user 含 createdAt」断言 seed createdAt=1 原样透传,通过;UserProfile.vue 原本已读 user.createdAt,无需改。

## 发现 3:Settings 双写路径
- 改动:`src/views/Settings.vue` 两按钮改 `preferences.setLanguage('zh'/'en')`,import usePreferencesStore,移除 setLocale import(文件内无其它 setLocale 用法,grep 实证)。
- 证据:语言切换现在走 store 单写路径(setLocale+localStorage+服务端双写),/profile 偏好卡与 fetchMe 回灌一致;`npx vitest run src/views` 44 文件 226 用例全过。

## 发现 4:被踢设备 K8s 凭据残留
- 改动:`server/routes/auth.mjs` 三个吊销路径(change-password 循环 / DELETE sessions/others / DELETE sessions/:fingerprint)在删平台会话同时 `sessions.delete(k8sSessionToken)` + try-DELETE sessions 表;:fingerprint 分支先 `platformSessions.get(hit)` 取被吊对象再删;当前会话路径均不动。
- 证据:新增测试「change-password:吊销其他会话时同步回收其 k8sSessionToken;当前会话的保留」——k8s-other 从 Map 消失、k8s-me 保留,通过。

## 发现 5:ALTER 迁移顺序陷阱
- 改动:`server/index.mjs` 4 条 platform try-ALTER 从 sessions 建表块后(L107-110)挪到 platform_sessions CREATE TABLE 之后,并加「顺序不变式」注释;CREATE 字面量保持现状(已含新列);确认后续语句无顺序依赖(仅建表/建 schema,ALTER 后无消费)。
- 证据:diff 可见 4 条 ALTER 现位于两张 platform 表 CREATE 之后;语义变为「存量库补列,新建库靠 CREATE」。

## 门禁
`node scripts/test.mjs`(113 过)&& `node --test server/auth-selfservice.test.mjs server/auth-login-rate.test.mjs`(14 过)&& `npx vitest run src/styles src/stores`(148 过)&& `npm run build` ✓ && `npm run i18n:check`(0/0/0)&& `npm run typecheck`(472 过)。
