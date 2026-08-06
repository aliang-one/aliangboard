# i18n Report: Language Switcher + SideNavBar Navigation Migration

## Summary

Implemented i18n for the sidebar navigation (`src/components/layout/SideNavBar.vue`) and added a compact language switcher (中文 / EN) at the bottom of the sidebar.

## Changes

### 1. Language Switcher

Added a compact toggle at the bottom of the sidebar (below Settings link). Uses `i18n.global.locale.value` for reactive active-state styling and `setLocale()` for persistence (localStorage). Import added: `import { i18n, setLocale } from '@/i18n'`.

### 2. Nav Arrays Migrated to i18n Keys

Items with matching locale keys were migrated from `label` to `labelKey`. Items without locale keys (technical terms: PriorityClasses, IngressClasses, RuntimeClasses, APIServices, Webhooks, ReplicaSets, CSINodes, 工作台, 集群管理 in platformAdminNav) retain hardcoded `label`.

#### clusterPrimaryNav (5 of 6 migrated)

| Item | labelKey |
|---|---|
| Cluster Overview | `nav.clusterOverview` |
| Nodes | `nav.nodes` |
| Namespaces | `nav.namespaces` |
| 存储 | `nav.storage` |
| 监控中心 | `nav.monitoring` |
| 工作台 | *(hardcoded - no key)* |

#### clusterResourcesNav (1 of 9 migrated)

| Item | labelKey |
|---|---|
| CRDs | `nav.crds` |
| PriorityClasses, IngressClasses, etc. | *(hardcoded - technical terms)* |

#### clusterOtherNav (2 of 2 migrated)

| Item | labelKey |
|---|---|
| Audit Logs | `nav.auditLogs` |
| Clusters | `nav.clusters` |

#### platformAdminNav (4 of 5 migrated)

| Item | labelKey |
|---|---|
| 用户管理 | `nav.userManagement` |
| API Keys | `nav.apiKeys` |
| AI 控制台 | `nav.aiConsole` |
| LLM 配置 | `nav.llmConfig` |
| 集群管理 | *(hardcoded - no matching key; `nav.clusterManagement` used for section header)* |

### 3. Template Updates

- Section header "集群管理" -> `$t('nav.clusterManagement')`
- Deploy button "Deploy New App" -> `$t('nav.deploy')`
- Settings link "Settings" -> `$t('nav.settings')`
- Each nav item rendering: `{{ item.labelKey ? $t(item.labelKey) : item.label }}`

### 4. nsNavGroups

Only "工作负载" group header migrated to `labelKey: 'nav.workloads'`. All other group headers (概览, 网络, 存储与配置, 安全, 策略) and all item labels remain hardcoded -- no matching locale keys exist.

## Verification

- `npm run build` passes successfully (built in ~10s, 182 modules transformed).
