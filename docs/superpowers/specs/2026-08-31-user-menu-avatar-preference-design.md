# 用户头像菜单优化：两行触发钮 + 快速偏好切换 — 设计

日期：2026-08-31
状态：已与用户逐节确认（§1 触发钮两行化 / §2 下拉快速切换区 / §3 数据流与测试）

## 1. 背景与目标

顶栏右上角 `UserMenu.vue` 现状：

- 触发钮一行横排：字母头像 + 用户名 + `ADMIN` 徽章（仅 admin）+ `expand_more` 箭头；
- 下拉菜单仅有资料卡、「用户中心」、「退出登录」，无任何偏好切换；
- 主题/语言切换目前只能进「用户中心」页（或 admin 设置页）才能改。

目标：

1. 触发钮两行化——角色文字从横排徽章移到用户名下方小字；
2. 下拉菜单新增**主题三态**（浅色/深色/跟随系统）与**语言两态**（中文/English）快速切换。

## 2. 方案裁决

| 备选 | 裁决 |
|------|------|
| A. UserMenu 自包含改造（推荐，采纳） | 直接在 `UserMenu.vue` 内完成两行触发钮 + 下拉偏好区，直接消费 `usePreferencesStore` 现成 `setTheme`/`setLanguage`，与组件头部注释声明的「自包含实现」模式一致，改动面最小 |
| B. 抽共享 `PreferenceSwitches` 组件 | 否决——菜单（紧凑）与用户中心页（大按钮带标签）密度差异大，强行共享需一堆尺寸 props，YAGNI |
| C. 改用公共 `DropdownMenu` 组件 | 否决——该组件仍 absolute 定位（z 层治理遗留），且本组件自包含开合是刻意设计，迁移无收益 |

用户已确认的两个交互裁决：

- **主题切换用三态分段按钮**（亮色/暗色/跟随系统），而非亮↔暗一步切换；三态语义与用户中心页一致，「跟随系统」不缺席；
- **角色行所有用户都显示本地化角色名**（管理员/普通用户），不再只有 admin 显示徽章。

## 3. 触发钮两行化（§1）

```
┌──────────────────────────┐
│ (头像)  Alice            ▾│
│         管理员            │   ← text-[10px] 小字，text-on-surface-variant
└──────────────────────────┘
```

- 左侧 32px 字母头像不变；中间纵向两行：上行用户名（保留 `text-body-sm font-semibold` + truncate + title），下行角色小字；
- 角色映射：`role === 'admin'` → `$t('admin.users.roleAdmin')`（管理员/Admin），否则 → `$t('admin.users.roleUser')`（普通用户/User）；`role` 缺失时隐藏角色行；复用既有键，**零新增 i18n 键**；
- 移除横排 `ADMIN` 徽章（由角色行取代）；`expand_more` 箭头保留；
- 触发/开合行为不变：点击开合菜单、document 级外部点击关闭、ESC 关闭、`data-testid="user-menu-trigger"` 不动。

## 4. 下拉菜单快速切换区（§2）

菜单结构（新增「快速切换区」，置于资料卡与「用户中心」之间）：

```
┌────────────────────────────┐
│ (大头像) Alice / alice      │   资料卡，不变
├────────────────────────────┤
│ 主题外观                    │   小节标签 $t('userCenter.theme')
│ [☀浅色][🌙深色][◐跟随系统]   │   三态分段，当前项 bg-primary text-on-primary
│ 界面语言                    │   小节标签 $t('userCenter.language')
│ [中文][English]             │   两态分段，同上高亮规则
├────────────────────────────┤
│ 👤 用户中心                 │   不变
├────────────────────────────┤
│ 🚪 退出登录（红）            │   不变
└────────────────────────────┘
```

- **分段按钮点击不关菜单**——用户能立即看到主题在菜单背后切换的效果；「用户中心」「退出登录」维持原有关菜单行为；
- 主题三态调 `prefs.setTheme('light' | 'dark' | 'system')`，图标沿用用户中心页 `light_mode` / `dark_mode` / `contrast`；
- 语言两态调 `prefs.setLanguage('zh' | 'en')`，切换即全站生效（`setLocale` + `<html lang>` 同步，现成逻辑）；
- 高亮归一：`prefs.theme` 为 `null`（未设置，store 语义 = system）按「跟随系统」高亮；`prefs.language` 为 `null`（i18n 默认 = zh）按「中文」高亮——比用户中心页「null 时都不亮」更如实反映运行时默认；
- 文案键全部复用：小节标签 `userCenter.theme`（主题外观）/`userCenter.language`（界面语言），按钮 `userCenter.themeLight/themeDark/themeSystem/langZh/langEn`（与用户中心页同源，双语现值：浅色/深色/跟随系统、中文/English），**整个特性零新增 i18n 键**，`i18n:check` 门禁零风险；
- testid：`user-menu-theme-<v>` / `user-menu-lang-<v>`（对齐用户中心页 `pref-theme-<v>` 命名习惯）。

## 5. 数据流（§3）

```
点分段按钮 → preferences.setTheme(v) / setLanguage(v)
  → 即时生效：applyThemeMode(v) / setLocale(v)（含 <html lang> 同步）
  → 双写持久化：localStorage + PUT /api/auth/preferences（失败静默=离线兜底，现成）
```

- UserMenu 只读 `prefs.theme` / `prefs.language` 两个 ref，高亮自动跟随；登录态建立时 `hydrateFromServer` 的服务端覆盖逻辑无需菜单关心；
- **零新增 API、零新增 store 状态、零新增依赖**。

## 6. 边界情况

- `prefs.theme` / `prefs.language` 为 `null`（新用户未设置）→ 高亮分别落在「跟随系统」/「中文」（见 §4）；
- 未知 `role` 值 → 视同普通用户显示「普通用户/User」；`role` 字段缺失 → 隐藏角色行；
- 菜单开合、ESC/外部点击关闭、登出 ConfirmDialog 链路一律不动。

## 7. 测试计划

扩展 `src/components/layout/__tests__/UserMenu.test.js`（vitest + happy-dom，沿用现有 seed/mount 模式）：

1. **触发钮两行**：admin 渲染角色行「管理员」；非 admin 渲染「普通用户」；横排 `ADMIN` 徽章不再出现（改写现有第 6 例「非 admin 用户不显示 ADMIN 徽章」）；
2. **分段按钮存在与高亮**：下拉含 5 个分段按钮（theme×3 + lang×2）；当前值正确高亮；含 `null → system / zh` 归一用例；
3. **切换行为**：点 `user-menu-theme-dark` → `prefs.theme === 'dark'` 且**菜单仍开**；点 `user-menu-lang-en` → `prefs.language === 'en'` 且 `i18n.global.locale.value === 'en'`；
4. **回归**：现有 6 例（开合/跳转/登出确认链）保持全绿——两行化不改任何 testid 与开合语义。

## 8. 验收口径

- `npm run test:unit`、`npm run i18n:check`、`npm run typecheck` 全绿；
- 真机手测（需浏览器）：① 头像两行形态与角色小字；② 主题三态即时切换（含跟随系统）；③ 语言切换全站即时生效且刷新后保持（服务端双写）；
- 实现按用户硬约束走 **git worktree 分支**，完成后 `--no-ff` 合回 main。

## 9. 范围外（明确不做）

- 不抽共享偏好切换组件（见 §2 方案 B 裁决）；
- 不动「用户中心」页现有偏好卡的形态（其 null 高亮行为保持现状，两处不一致已在 §4 说明理由）；
- 不迁移公共 `DropdownMenu` 组件、不改 z 层；
- 不涉及 SSH/网关/服务端改动——纯前端组件改造。
