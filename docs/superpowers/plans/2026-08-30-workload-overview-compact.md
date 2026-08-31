# Workload Overview 紧凑化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workload 详情页两处紧凑化——历史版本的 期望/当前/就绪 与操作按钮合并成一行(左列卡+中列详情面板),PodCard 的 CPU/内存数值移到进度条下方并缩小字体,结构性根除窄列文字溢出。

**Architecture:** 纯前端模板手术,零数据层改动。三处独立模板块(NsWorkloadDetail 左列卡/中列面板 + PodCard 行3),各自以「锁结构」单测先行(data-testid 断言合并行容器内同时渲染指标与按钮/数值在条下方块内)。

**Tech Stack:** Vue 3 `<script setup>` + Tailwind 任意值字号(vitest + @vue/test-utils + happy-dom 单测)。

**规格:** `docs/superpowers/specs/2026-08-30-workload-overview-compact-design.md`(已批准)

## Global Constraints

- 当前就在 worktree 分支 `worktree-feat+workload-overview-compact` 上;所有编辑/命令用 worktree 绝对路径前缀 `/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat+workload-overview-compact/`(EnterWorktree 只切 Bash cwd,Edit/Write 必须显式绝对路径)。
- node_modules 已软链主仓(`ln -sfn`),勿 `npm install`。
- 零新增依赖、零新增 i18n 键(全部复用 `workload.revision.desired/current/ready/rollback/delete` 等既有键;`i18n:check` 应全绿)。
- PodCard 全局一套布局,**不加 prop 分叉**(5 个消费方统一)。
- 字号规格:合并行标签 `text-[9px]`、数值 `font-mono text-[10px] font-bold`;PodCard 标签与数值 `text-[10px]`(原 11px)。色带阈值(>80 error / >60 tertiary-container / 其余 primary|secondary)不变。
- 测试 locale:src/i18n.js 在 vitest 下默认 `'zh'`,断言可直接用中文文案(期望/当前/就绪/回滚/删除)。
- 提交作者恒 `aliangone <aliangone@gmail.com>`(repo config 已设),**禁止** `Co-Authored-By: Claude` 尾注;禁改写已推送历史。
- 单测命令 `npx vitest run <file>`(vitest 已全局提额超时);全量门禁 = `npm run test:unit` + `npm run typecheck` + `npm run i18n:check`。
- `data-testid` 新增清单(后续任务断言与实现必须一字不差):`pod-metrics` / `pod-cpu-block` / `pod-cpu-bar` / `pod-cpu-value` / `pod-mem-block` / `pod-mem-bar` / `pod-mem-value`(PodCard);`rev-card` / `rev-metrics-row`(左列卡);`rev-detail-compact-row`(中列面板)。

---

### Task 1: PodCard 行3 数值下移+缩小字体(TDD)

**Files:**
- Modify: `src/components/common/PodCard.vue:116-128`(行3 模板块)
- Test: `src/components/common/__tests__/PodCard.test.js`(追加 3 个用例)

**Interfaces:**
- Consumes: 现有 `cpuPct`/`memPct` computed(`podCpuPct`/`podMemPct`,pctRatio 已防 total=0)、`pod.cpu`/`pod.memory` 字符串 `"124m/500m"` 格式。均不变。
- Produces: 行3 新 DOM 契约(供本任务测试锁定,无其他消费方):容器 `data-testid="pod-metrics"` 带 `max-w-sm`;每个指标一个 `data-testid="pod-{cpu|mem}-block"`(含 `min-w-0`),内部条 `data-testid="pod-{cpu|mem}-bar"` 在上、数值 `data-testid="pod-{cpu|mem}-value"`(`truncate`)在下。

- [ ] **Step 1: 写失败测试**(追加到 `src/components/common/__tests__/PodCard.test.js` 末尾)

```js
test('行3 指标:数值在进度条下方同块内,truncate+min-w-0 防溢出结构', () => {
  const w = mountCard({ pod: { ...POD, cpu: '124m/500m', memory: '182Mi/512Mi' } })
  const row = w.find('[data-testid="pod-metrics"]')
  expect(row.exists()).toBe(true)
  expect(row.classes()).toContain('max-w-sm')          // 整行封顶,宽页进度条不拉满屏
  const cpuBlock = w.find('[data-testid="pod-cpu-block"]')
  expect(cpuBlock.exists()).toBe(true)
  expect(cpuBlock.classes()).toContain('min-w-0')      // flex 子项可收缩,溢出根因链
  expect(cpuBlock.find('[data-testid="pod-cpu-bar"]').exists()).toBe(true)
  const cpuValue = cpuBlock.find('[data-testid="pod-cpu-value"]')
  expect(cpuValue.text()).toBe('124m/500m')
  expect(cpuValue.classes()).toContain('truncate')
  const memValue = w.find('[data-testid="pod-mem-value"]')
  expect(memValue.text()).toBe('182Mi/512Mi')
  expect(memValue.classes()).toContain('truncate')
})

test('行3 超长数值:truncate 兜底不产生横向溢出结构', () => {
  const w = mountCard({ pod: { ...POD, cpu: '11234m/500m', memory: '1182Mi/512Mi' } })
  const v = w.find('[data-testid="pod-cpu-value"]')
  expect(v.text()).toBe('11234m/500m')
  expect(v.classes()).toContain('truncate')
  expect(w.find('[data-testid="pod-cpu-block"]').classes()).toContain('min-w-0')
})

test('行3 无 metrics 不渲染(现状回归)', () => {
  const w = mountCard()
  expect(w.find('[data-testid="pod-metrics"]').exists()).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat+workload-overview-compact && npx vitest run src/components/common/__tests__/PodCard.test.js`
Expected: 新增用例 FAIL(`pod-metrics` 不存在 → `expect(row.exists()).toBe(true)` 失败);既有 4 用例仍 PASS。

- [ ] **Step 3: 实现**——把 `PodCard.vue` L116-128 的行3整块替换为:

```html
    <!-- 行3：CPU / MEM 指标（条在上、数值在下；块 min-w-0+数值 truncate 根除窄列溢出；整行 max-w-sm 防宽页拉满） -->
    <div v-if="hasMetrics" data-testid="pod-metrics" class="flex gap-md mt-1 max-w-sm">
      <div v-if="pod.cpu" data-testid="pod-cpu-block" class="flex-1 min-w-0">
        <div class="flex items-center gap-1">
          <span class="text-[10px] text-on-surface-variant/50 w-6 shrink-0">CPU</span>
          <div data-testid="pod-cpu-bar" class="flex-1 h-1 bg-outline-variant/25 rounded-full overflow-hidden"><div class="h-full rounded-full" :class="cpuPct > 80 ? 'bg-error' : cpuPct > 60 ? 'bg-tertiary-container' : 'bg-primary'" :style="{ width: cpuPct + '%' }"></div></div>
        </div>
        <p data-testid="pod-cpu-value" class="font-mono text-[10px] text-on-surface-variant/70 leading-none mt-1 pl-7 truncate" :title="pod.cpu">{{ pod.cpu }}</p>
      </div>
      <div v-if="pod.memory" data-testid="pod-mem-block" class="flex-1 min-w-0">
        <div class="flex items-center gap-1">
          <span class="text-[10px] text-on-surface-variant/50 w-6 shrink-0">MEM</span>
          <div data-testid="pod-mem-bar" class="flex-1 h-1 bg-outline-variant/25 rounded-full overflow-hidden"><div class="h-full rounded-full" :class="memPct > 80 ? 'bg-error' : memPct > 60 ? 'bg-tertiary-container' : 'bg-secondary'" :style="{ width: memPct + '%' }"></div></div>
        </div>
        <p data-testid="pod-mem-value" class="font-mono text-[10px] text-on-surface-variant/70 leading-none mt-1 pl-7 truncate" :title="pod.memory">{{ pod.memory }}</p>
      </div>
    </div>
```

要点:`pl-7`(24px 标签+4px gap)使数值左缘对齐进度条起点;色带三元与原逻辑逐字一致,仅外壳换。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/PodCard.test.js`
Expected: 7 个用例全 PASS。

- [ ] **Step 5: 提交**

```bash
cd /home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat+workload-overview-compact
git add src/components/common/PodCard.vue src/components/common/__tests__/PodCard.test.js
git commit -m "feat(podcard): 行3 指标数值下移至进度条下方+11px→10px,min-w-0+truncate+max-w-sm 根除窄列溢出"
```

---

### Task 2: 左列版本卡「指标+操作」合并行(TDD)

**Files:**
- Create: `src/views/__tests__/NsWorkloadDetail.revision-compact.test.js`(新测试文件,mock 策略复制 edit-shell 测试)
- Modify: `src/views/NsWorkloadDetail.vue`(~L1437-1472,左列版本卡 v-for 块)

**Interfaces:**
- Consumes: 现有 `revReadyClass(rev)`(着色)、`viewRevYaml/confirmRollback/confirmDeleteRev`(操作,原样保留)、store.fetchWorkloadRevisions(mock 直接返回 fixture)。
- Produces: 左列卡 DOM 契约——卡按钮 `data-testid="rev-card"`;合并行 `data-testid="rev-metrics-row"` 内同时含三个指标行内对(标签 text-[9px] + 数值 text-[10px] mono bold)与操作按钮组。

- [ ] **Step 1: 建测试文件写失败测试**

```js
// NsWorkloadDetail 版本区紧凑化测试:锁定「左列卡 指标+操作 合并行」与「中列详情面板 合并行」
// 的结构现状(规格 docs/superpowers/specs/2026-08-30-workload-overview-compact-design.md)。
// mock 策略与 NsWorkloadDetail.edit-shell.test.js 一致(mock @/api/client 与 @/stores/cluster,
// 真实 i18n + Vue Query),额外 mock fetchWorkloadRevisions 供左列版本卡渲染。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
// Deployment + 两个 owned ReplicaSet 派生的 revision 形状(字段与 buildRevisions 输出一致)
const REVISIONS = [
  { rev: 3, image: 'nginx:1.25', sha: 'abc1234', age: '2d', reason: 'bump tag', current: true, replicas: 2, readyReplicas: 2, desiredReplicas: 2, rsName: 'demo-deploy-7d9f', rsUid: 'uid-3' },
  { rev: 2, image: 'nginx:1.24', sha: 'def5678', age: '5d', reason: 'prev', current: false, replicas: 0, readyReplicas: 0, desiredReplicas: 2, rsName: 'demo-deploy-5c8a', rsUid: 'uid-2' },
]
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [{
    name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
    raw: {
      metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
      spec: {
        replicas: 1, selector: { matchLabels: { app: 'demo' } },
        template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } },
      },
    },
  }]),
  fetchPods: vi.fn(async () => []),
  fetchWorkloadRevisions: vi.fn(async () => REVISIONS),
  fetchPVCs: vi.fn(async () => []),
  fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  updateWorkload: vi.fn(), applyWorkloadTemplate: vi.fn(),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default', type: 'deployment' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}

test('左列版本卡:期望/当前/就绪 与操作按钮在同一行容器(合并行)', async () => {
  const w = mountDetail()
  await flushPromises()
  const rows = w.findAll('[data-testid="rev-metrics-row"]')
  expect(rows.length).toBe(2)                       // 两张版本卡各一行
  const hist = rows[1]                              // rev2(非活跃):3 个操作按钮
  expect(hist.text()).toContain('期望')
  expect(hist.text()).toContain('当前')
  expect(hist.text()).toContain('就绪')
  expect(hist.findAll('button').length).toBe(3)     // 查看 YAML/回滚/删除 与指标同容器
  expect(rows[0].findAll('button').length).toBe(1)  // 活跃卡仅 查看 YAML
  w.unmount()
})
```

注意 route params 需带 `type: 'deployment'`(revisions query 的 TYPE_MAP 用它映射 Deployment)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.revision-compact.test.js`
Expected: FAIL(`rev-metrics-row` 不存在)。若挂载本身报错,先修 mock(对照 edit-shell 测试的依赖),再回到红灯。

- [ ] **Step 3: 实现**——`NsWorkloadDetail.vue` 两处手术:

(a) 卡片按钮加 testid(L1437):

```html
<button v-for="rev in revisions" :key="rev.rev" data-testid="rev-card" @click="selectRev(rev)"
```

(b) 把「副本统计」grid(L1451-1465,含注释行)与「操作」div(L1466-1471,含注释行)**整两块删除**,替换为一个合并行:

```html
              <!-- 副本统计 + 操作：合并单行（指标左、操作右；去盒子背景降高度） -->
              <div data-testid="rev-metrics-row" class="flex items-center gap-1.5 mt-1 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0" :class="rev.current ? 'text-on-primary/70' : 'text-on-surface-variant/50'">
                  <span class="text-[9px] leading-none shrink-0">{{ $t('workload.revision.desired') }}<b class="ml-0.5 font-mono text-[10px] font-bold leading-none" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">{{ rev.desiredReplicas ?? '—' }}</b></span>
                  <span class="text-[9px] leading-none shrink-0">{{ $t('workload.revision.current') }}<b class="ml-0.5 font-mono text-[10px] font-bold leading-none" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">{{ rev.replicas ?? 0 }}</b></span>
                  <span class="text-[9px] leading-none shrink-0">{{ $t('workload.revision.ready') }}<b class="ml-0.5 font-mono text-[10px] font-bold leading-none" :class="revReadyClass(rev)">{{ rev.readyReplicas ?? 0 }}</b></span>
                </div>
                <div class="flex items-center ml-auto shrink-0 -mr-0.5">
                  <button @click.stop="viewRevYaml(rev)" class="p-1 rounded hover:bg-on-surface/10" :class="rev.current ? 'text-on-primary/90 hover:text-on-primary' : 'text-on-surface-variant hover:text-primary'" :title="$t('workload.revision.viewYaml')"><span class="material-symbols-outlined text-sm">code</span></button>
                  <button v-if="!rev.current" @click.stop="confirmRollback(rev)" class="p-1 rounded hover:bg-primary/10 text-primary" :title="$t('workload.revision.rollbackTo')"><span class="material-symbols-outlined text-sm">undo</span></button>
                  <button v-if="!rev.current" @click.stop="confirmDeleteRev(rev)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" :title="$t('workload.revision.deleteRev')"><span class="material-symbols-outlined text-sm">delete</span></button>
                </div>
              </div>
```

要点:三个操作按钮的 class 与点击处理器从旧「操作」行**逐字搬运**,不改动行为;只删指标盒子结构。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.revision-compact.test.js`
Expected: PASS(1 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.revision-compact.test.js
git commit -m "feat(workload): 左列版本卡 期望/当前/就绪 与操作按钮合并单行(去盒子,单卡省约30px)"
```

---

### Task 3: 中列历史版本详情面板「指标+操作」合并行(TDD)

**Files:**
- Modify: `src/views/__tests__/NsWorkloadDetail.revision-compact.test.js`(追加用例)
- Modify: `src/views/NsWorkloadDetail.vue`(~L1518-1560,中列历史版本详情模板块)

**Interfaces:**
- Consumes: Task 2 的 `data-testid="rev-card"`(点击切换 selectedRev);`viewRevYaml/confirmRollback/confirmDeleteRev/revReadyClass` 原样。
- Produces: 中列面板 DOM 契约——`data-testid="rev-detail-compact-row"` 单行容器,内含三指标行内对 + YAML/回滚/删除 三按钮;旧吸底操作条(`mt-auto` grid-cols-3)整体消失。

- [ ] **Step 1: 追加失败测试**(到 Task 2 测试文件末尾)

```js
test('中列历史版本详情:指标与 YAML/回滚/删除 合并为一行', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.findAll('[data-testid="rev-card"]')[1].trigger('click')   // 选中 rev2(历史)
  await flushPromises()
  const row = w.find('[data-testid="rev-detail-compact-row"]')
  expect(row.exists()).toBe(true)
  expect(row.text()).toContain('期望')
  expect(row.text()).toContain('当前')
  expect(row.text()).toContain('就绪')
  const ops = row.findAll('button').map(b => b.text()).join()
  expect(ops).toContain('YAML')
  expect(ops).toContain('回滚')
  expect(ops).toContain('删除')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.revision-compact.test.js`
Expected: 新用例 FAIL(`rev-detail-compact-row` 不存在);Task 2 用例仍 PASS。

- [ ] **Step 3: 实现**——中列历史版本详情模板两处手术:

(a) 把「副本统计」3 列 grid(L1528-1542,含注释行)删除,原位替换为合并行:

```html
              <!-- 副本统计 + 操作：合并单行（指标左、操作右；旧吸底操作条移除） -->
              <div data-testid="rev-detail-compact-row" class="flex items-center gap-1.5 px-md py-sm border-b border-outline-variant/40 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0 text-on-surface-variant/50">
                  <span class="text-[9px] leading-none shrink-0">{{ $t('workload.revision.desired') }}<b class="ml-0.5 font-mono text-[10px] font-bold leading-none text-on-surface">{{ selectedRev.desiredReplicas ?? '—' }}</b></span>
                  <span class="text-[9px] leading-none shrink-0">{{ $t('workload.revision.current') }}<b class="ml-0.5 font-mono text-[10px] font-bold leading-none" :class="(selectedRev.replicas ?? 0) > 0 ? 'text-primary' : 'text-on-surface-variant/50'">{{ selectedRev.replicas ?? 0 }}</b></span>
                  <span class="text-[9px] leading-none shrink-0">{{ $t('workload.revision.ready') }}<b class="ml-0.5 font-mono text-[10px] font-bold leading-none" :class="revReadyClass(selectedRev)">{{ selectedRev.readyReplicas ?? 0 }}</b></span>
                </div>
                <div class="flex items-center gap-0.5 ml-auto shrink-0">
                  <button @click="viewRevYaml(selectedRev)" class="flex items-center gap-0.5 px-1.5 py-1 rounded-md text-[11px] text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-colors"><span class="material-symbols-outlined text-sm">code</span>YAML</button>
                  <button @click="confirmRollback(selectedRev)" class="flex items-center gap-0.5 px-1.5 py-1 rounded-md text-[11px] text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-colors"><span class="material-symbols-outlined text-sm">undo</span>{{ $t('workload.revision.rollback') }}</button>
                  <button @click="confirmDeleteRev(selectedRev)" class="flex items-center gap-0.5 px-1.5 py-1 rounded-md text-[11px] text-on-surface-variant hover:text-error hover:bg-error/5 transition-colors"><span class="material-symbols-outlined text-sm">delete</span>{{ $t('workload.revision.delete') }}</button>
                </div>
              </div>
```

(b) 删除底部旧「操作(吸底)」整块(L1554-1559,`mt-auto px-md py-md border-t … grid grid-cols-3` 那个 div 及其注释)。元信息 div(L1543-1553)原样保留在合并行之后。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.revision-compact.test.js`
Expected: 2 个用例全 PASS。

- [ ] **Step 5: 回归全量单测**(PodCard 5 处消费方中 NsPods/NsServiceDetail/NodeDetail/PodDetail 若有相关测试一并过)

Run: `npm run test:unit`
Expected: 全绿(若有他视图测试因行3结构断言而红,逐个核对——预期没有,该结构此前无测试锁定)。

- [ ] **Step 6: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.revision-compact.test.js
git commit -m "feat(workload): 中列历史版本详情面板 指标+操作合并单行,移除吸底操作条(面板省约76px)"
```

---

### Task 4: 门禁+手测清单+合并回 main

**Files:**
- 无新改动;门禁跑全量,合并回主 checkout。

**Interfaces:**
- Consumes: Task 1-3 的全部提交(分支 `worktree-feat+workload-overview-compact`)。
- Produces: main 上的合并提交(--no-ff)。

- [ ] **Step 1: 全量门禁**(worktree 内)

```bash
cd /home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat+workload-overview-compact
npm run test:unit && npm run typecheck && npm run i18n:check
```
Expected: 三项全绿(i18n 无新键,typecheck `node --check` 全过)。

- [ ] **Step 2: 手测清单输出给用户**(需真集群+浏览器,合并前或合并后均可;纯模板改动风险低):
  1. Workload 详情(有历史版本的 Deployment):左列卡 3 行结构(头/镜像/合并行),合并行内指标+按钮无挤压换行;
  2. 点历史版本:中列面板合并行渲染 YAML/回滚/删除,旧吸底条消失,回滚/删除弹确认框行为不变;
  3. 活跃版本卡:合并行 on-primary 配色正常;
  4. 中列 300px 窄列:PodCard 数值在条下方,长数值截断有省略号+悬停 title,不溢出边框;
  5. Pods 列表页 / Service 详情 / Node 详情 / Pod 详情:PodCard 新布局协调,进度条拉长不超过 max-w-sm。

- [ ] **Step 3: 终审后合并回 main**(多会话并行,合并前必查主 checkout 状态;须在 superpowers:finishing-a-development-branch / 代码评审通过后执行)

```bash
git -C /home/liang/MyProgram/AiProject/aliangboard branch --show-current   # 必须输出 main
git -C /home/liang/MyProgram/AiProject/aliangboard status --porcelain      # 必须为空,脏则停下问用户
git -C /home/liang/MyProgram/AiProject/aliangboard merge --no-ff worktree-feat+workload-overview-compact -m "Merge branch 'worktree-feat+workload-overview-compact'——workload overview 紧凑化:历史版本指标+操作合并行(左列卡+中列面板)+PodCard 指标数值下移缩小字体根除窄列溢出"
```
Expected: 合并完成;worktree 保留至用户确认手测后再 ExitWorktree(remove)。

- [ ] **Step 4: 收尾记忆**——按记忆惯例写/更新 `~/.claude/projects/.../memory/` 特性完成条目(含手测遗留项)。
