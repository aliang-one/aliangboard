# 用户中心 + 退出确认 + 暗色主题系统 设计文档

日期:2026-08-29
状态:已获用户批准(brainstorming 定案)
分支:`feat/user-center`(自本地 main 1db39b5 切出,worktree 开发)

## 0. 背景与问题清单(系统检查结论)

### 核心问题:头像整块 = 登出按钮
`src/components/layout/TopNavBar.vue:292-297`:头像圆点 + 用户名 + ADMIN 徽章 + 登出图标是**同一个 `<button>`,唯一 click 处理器是立即 `logout()`**——无下拉菜单、无确认、无其他入口。误触即登出,工作台对话/终端全断。

### 认知纠正:admin 用户管理中心已存在
`/admin/users`(用户 CRUD + 分配集群 + 重置密码 + 禁用)与 `/admin/clusters`、`/admin/apikeys`、`/admin/llm-config`、`/admin/ai-behavior`、`/admin/audit-trail` 共 6 页均已存在(侧边栏 admin 分区)。**真正缺的是个人自助用户中心**:`/api/auth/me` 只读,服务端没有任何 self-service 端点,用户改自己密码/显示名只能找 admin。

### 顺带发现的相关缺口(本期一并修/登记)
| # | 问题 | 处置 |
|---|------|------|
| G1 | 登出无二次确认 | 本期修(ConfirmDialog) |
| G2 | 用户无法自助改密/改显示名 | 本期修(self-service 端点) |
| G3 | 无会话管理(看不到活跃会话/无法远程登出) | 本期修(会话列表+吊销) |
| G4 | 禁用用户不回收存量会话(被禁用者会话仍有效) | 本期修会话基建后,admin 禁用/改密路径**不在本期**回收会话,列 follow-up F1 |
| G5 | admin 建用户/重置密码无密码长度校验 | 本期顺带统一 ≥8 |
| G6 | `fetchMe` catch-all 即登出(网络抖动也登出) | 本期修(仅 401/403 登出) |
| G7 | 语言/主题无用户级偏好(语言锁浏览器) | 本期修(偏好系统) |
| G8 | 暗色模式缺失(`darkMode:'class'` 已配但无暗色板,调色板为静态 hex) | 本期修(工作流 2) |
| G9 | WS 消息语言随浏览器(不随用户偏好) | **不修**,follow-up F2 |

## 1. 范围(用户裁决)

- **完整版**:资料编辑 + 修改自己密码 + 会话管理 + 偏好(语言、主题)。
- **暗色模式进一期**(用户明确选择),与用户中心拆为**两个工作流**,顺序交付、各自可独立合并:
  - 工作流 1:用户中心(头像菜单 + ConfirmDialog + `/profile` + 服务端 self-service)。
  - 工作流 2:暗色主题系统(调色板改造 + MD3 暗色板 + 偏好持久化接线)。
- 偏好存储:**服务端 + localStorage 双写**(裁决)。
- 用户中心承载:**头像下拉菜单 + 独立路由页 `/profile`**(裁决,不做纯弹窗)。
- 会话管理:**带设备信息**(ip/ua/最近活跃,裁决)。
- 确认弹窗:**自研 ConfirmDialog**(裁决,不引第三方;存量原生 `confirm()` 替换列 follow-up F3)。
- 主题选择器三态:浅色 / 深色 / 跟随系统(惯例裁定)。
- 改自己密码成功后:**吊销其他所有会话、保留当前**(安全惯例裁定)。

## 2. 工作流 1:用户中心

### 2.1 头像下拉菜单
新增 `src/components/layout/UserMenu.vue`,替换 `TopNavBar.vue:292-297`。

- 触发区(展示不变):头像圆点 + 用户名 + ADMIN 徽章;点击**开菜单**,不再登出。
- 下拉菜单(复用 TopNavBar 现有下拉模式:`absolute top-full` + 固定遮罩点击关闭;补 ESC 关闭):
  - 头部资料卡:头像(首字母)、displayName、username、role 徽章;
  - 菜单项「用户中心」→ `/profile`;
  - 分隔线;
  - 菜单项「退出登录」(error 色)→ ConfirmDialog 确认后执行现有登出流程(`store.stopPodWatch()/stopEventWatch()` → `authStore.logout()` → `/login`)。
- 登出逻辑本身零改动,只换入口。

### 2.2 ConfirmDialog 组件
新增 `src/components/common/ConfirmDialog.vue`(内部基于 `Modal.vue`):

- API:`v-model` + `title/message/confirmText/cancelText/danger` + `@confirm/@cancel`;`danger` 态确认按钮 error 色。
- 一期消费方:登出确认、会话吊销、退出其他设备。
- 测试注意:Teleport 弹层断言须查 `document.body`(既往教训)。

### 2.3 用户中心页 `/profile`
新增 `src/views/UserProfile.vue`;路由 `name: 'UserProfile'`、`path: '/profile'`、`meta: { titleKey: 'route.profile', requiresCluster: false }`(平台层页面,与 `/admin/users` 同级先例;普通用户可访问,无需 admin)。侧边栏**不加入口**,仅头像菜单进入。纵向三卡:

1. **资料卡**:大头像(首字母)、username(只读)、role 徽章、createdAt 注册时间;displayName 就地编辑 → `PATCH /api/auth/me`,成功后刷新 authStore.user。
2. **安全卡**:
   - 修改密码:旧密码 / 新密码 / 确认新密码;客户端先做一致性+长度校验,服务端 scrypt 验旧密码 + 新密码 ≥8;成功后服务端吊销该用户其他全部会话,前端 toast「其他设备已退出」。
   - 活跃会话列表:`GET /api/auth/sessions`;每行显示 IP、UA 摘要(解析家族名,如 Chrome/Chrome Mobile/Safari+OS)、创建时间、最近活跃、**当前会话**标记;行内「吊销」(ConfirmDialog danger);卡底「退出其他所有设备」(ConfirmDialog danger)。
3. **偏好卡**:语言(en/zh)、主题(浅色/深色/跟随系统)。语言即时生效;主题视觉在工作流 2 合并后生效(选择器先落,store 持久化两侧都通)。

### 2.4 preferences store
新增 `src/stores/preferences.js`:

- state:`{ language: 'en'|'zh'|null, theme: 'light'|'dark'|'system'|null }`(null = 未设置)。
- **三级来源**:① 启动时读 localStorage 兜底(登录页/未登录也生效);② 登录态建立时以服务端为准覆盖(登录响应自带 `prefs`;会话恢复走 `GET /api/auth/me` 的 `prefs`);③ 变更时本地即时生效 + 写 localStorage + `PUT /api/auth/preferences`(失败静默,本地已生效;以最后写入为准)。
- 语言生效:`vue-i18n` `locale.value` 切换 + API 层 `Accept-Language` 头跟随偏好(现按 navigator.language)。WS 语言随浏览器的遗留不动(F2)。
- 主题生效:工作流 2 的 `applyTheme()`(见 §3)。

## 3. 工作流 2:暗色主题系统(方案 A:RGB 三元组 + `<alpha-value>`)

### 3.1 调色板改造(`src/styles/md-palette.js` 单一来源不动摇)
- `MD_PALETTE`(亮色 hex,**值不动**)继续作为 ECharts/JS 消费源。
- 新增 `DARK_PALETTE`:MD3 暗色调性——深色 surface 阶(约 `#111418` 起)、primary 沿 emerald 提亮(tonal 80 附近)、on-surface 反白、outline-variant 提灰;错误/警示/第三色按 MD3 暗色 tonal 规则推导。具体色值实施时以 MD3 tonal palette 规则产出入库。
- 新增 `hexToRgbTriplet()`(hex → `"R G B"` 空格三元组);`installPaletteVars(palette)` 改注三元组到 `:root`(亮)与 `.dark`(暗)两套。
- 新增 `applyTheme(mode)`:`light|dark|system` → 设 `<html>` 的 `dark` class;`system` 态监听 `matchMedia('(prefers-color-scheme: dark)')` 并联动。
- 新增 `activePalette()` getter:返回当前生效色板对象(ECharts 用)。

### 3.2 Tailwind 接线(`tailwind.config.js`)
- `colors` 从静态 hex 展开改为 `rgb(var(--md-sys-color-<name>) / <alpha-value>)` 形式(小工具函数从 MD_PALETTE 键名生成)。
- Tailwind 3.4.19 原生支持 `<alpha-value>` → **全站现有 `bg-primary/10`、`border-outline-variant/30` 等透明度写法零改动**。
- 18 处既有 `var(--md-sys-color-*)` 裸用(main.css prose-chat 等)自动跟随变量切换,无需改。

### 3.3 图表与代码主题
- `src/lib/chart-options.js`:所有 `MD_PALETTE[...]` 取色改走 `activePalette()`(单点改造);`EChart.vue` watch 主题态变化 → `setOption` 重渲(渐变/tooltip 照旧)。
- `src/styles/code-theme.js` 本就是暗底代码主题,**不动**(暗色模式下视觉连续)。

### 3.4 首帧防白闪 + 硬编码盘点
- `index.html` `<head>` 加数行内联脚本:首帧前按 localStorage 偏好设 `dark` class(登录页/刷新均无闪白)。
- 全量 `grep` 硬编码色(`bg-white|text-black|text-white|#[0-9a-fA-F]{6}` 于模板/样式)盘点,命中处换语义 token;**此项作为暗色验收门槛**(以真实 DOM 截图/DOM 实测走查为准,警惕截图幻觉的既往教训)。

## 4. 服务端设计

### 4.1 Schema 迁移(项目惯用 `try { ALTER TABLE } catch { /* 列已存在 */ }`)
- `platform_sessions` 加 `lastSeenAt INTEGER`、`ip TEXT`、`userAgent TEXT`;login 时写 ip/ua;`requirePlatform` 命中时节流回写 `lastSeenAt`(**距上次 >60s 才写库**,SQLite 同步写禁每请求一写;内存 Map 侧即时更新)。
- `platform_users` 加 `prefs TEXT`(JSON 字符串;注意 node:sqlite 绑定仅接受标量,string 安全)。

### 4.2 新端点(全部登记 `server/route-auth-map.mjs` 的 ROUTE_AUTH——架构约束;消息走 `messages.mjs` 双语表;敏感操作写审计)

| 端点 | auth | 语义 |
|---|---|---|
| `PATCH /api/auth/me` | platform | 改 displayName;**服务端字段白名单**(仅 displayName),username/role/password 不可穿越;返回 `{ user }` |
| `POST /api/auth/change-password` | platform | body `{ currentPassword, newPassword }`;scrypt 验旧密码(失败 401 语义,审计 `platform_change_password` denied)→ newPassword ≥8 → 更新 `passwordHash` → **删除该用户除当前 token 外全部会话**(内存 Map + DB 双删);审计 ok |
| `GET /api/auth/sessions` | platform | 列当前用户会话:token **仅回传前 8 位指纹**、ip、UA 摘要、createdAt、lastSeenAt、`current` 标记;权威源=内存 `platformSessions` Map(DB 仅重启恢复源) |
| `DELETE /api/auth/sessions/others` | platform | 原子吊销除当前外全部会话(审计) |
| `DELETE /api/auth/sessions/:fingerprint` | platform | 按 8 位指纹吊销指定会话(仅自己的;非当前会话才可吊;审计) |
| `PUT /api/auth/preferences` | platform | body `{ language?, theme? }` 白名单校验(`en/zh`;`light/dark/system`)→ JSON 写 `prefs` 列;返回 `{ prefs }` |

- `GET /api/auth/me` 返回体扩展 `prefs`(`JSON.parse` 容错,坏数据视作 null)。
- 登录响应同步带 `prefs`(登录后首屏免再取)。

### 4.3 顺带统一(G5)
- `POST /api/admin/users`(建用户)与 `/reset-password` 补 newPassword/password ≥8 校验,与自改同规则。

## 5. 错误处理与边界

- 改密/吊销后被踢端:下一个请求 401 → 走现有 401 拦截跳登录(实施时核对该拦截路径行为)。
- `fetchMe` 修为仅 401/403 才 `logout()`,网络错误保留会话(G6)。
- 偏好 `PUT` 失败:静默降级本地已生效;服务端/本地以最后写入为准(可接受回灌)。
- 会话列表里「当前会话」不可自吊(UI 防呆 + 服务端拒绝),防自锁。
- i18n 新键全部双语对齐,字面 `@` 按 `{'@'}` 转义;过 `npm run i18n:check` 门禁。

## 6. 测试策略

- **服务端**(`npm test`,自研运行器 + node --test):auth 路由扩展——PATCH me 白名单穿越拒绝;change-password 旧密错误/长度不足/成功踢会话(其余会话失效、当前保留);sessions 列表指纹不回传全 token、others 原子吊销、按指纹吊销与自吊拒绝;preferences 读写与非法值拒绝;ROUTE_AUTH 守卫测试自动覆盖新端点;admin 建用户/重置 ≥8 校验。
- **前端**(`npm run test:unit`,vitest):preferences store 三级来源/降级;md-palette 三元组转换与 applyTheme/activePalette;ConfirmDialog(Teleport 查 body);UserMenu(菜单开合、ESC/遮罩关闭、登出确认流、确认前不登出);UserProfile 三卡交互(改 displayName、改密表单校验、会话吊销)。
- **手测清单**(需运行环境):双主题全页走查(含图表/代码块/登录页)、语言切换、双浏览器改密踢会话、会话列表设备识别、登录页主题兜底、刷新无白闪。

## 7. Follow-up(本期不做)

- F1:admin 禁用用户时回收其存量会话(复用本期会话吊销基建)。
- F2:WS 消息语言跟随用户偏好。
- F3:存量 10 处原生 `confirm()` 替换为 ConfirmDialog。
- F4:审计查看器(MCP/API-key 调用 UI,既有独立需求,不受本期阻塞)。
- F5(终审):主动 logout 不回收自身 k8sSessionToken(本特性已修「改密/吊销其他会话」路径的回收,主动登出路径为既有行为,同源缺口)。
- F6(终审):SideNavBar 停靠坞/ns 带约 40 处手调绿 hex 暗色不翻转(对比度不塌,视觉为「亮岛」)——**合并前须真机暗色走查一次侧边栏并记录结论**;批量换 token 风险大于收益,暂保持。
- F7(终审):ApiKeyManagement dotColor 三态固定语义色换 `tokenHexR('status-*')`(3 行,暗板已备提亮值)。
- F8(终审):preferences `persist()` 加平台 token 存在性判断(当前不可达;未来任何 pre-login 调用方会触发 401→强跳登录)。
- F9(终审):杂项——UserMenu 触发钮补 `aria-expanded`/`aria-haspopup`;ConfirmDialog `loading` 接入吊销/改密 pending;`tokenHex` 死代码与 `/profile` 路由死 `meta.icon` 清理;TopNavBar.test.js `logoutBtn` 变量名;chart-options「零依赖」注释弱化记档(经 theme.js 引 vue,node 仍可解析)。
