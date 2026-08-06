# Task 1 Report: 高级设置 Expansion in DeployApp.vue

## Changes Made

All 4 changes applied to `src/views/DeployApp.vue` (+131 lines, -1 line):

### 1. Form Fields (makeForm)
Added after `securityContext` field, before `lifecycle`:
- `podSecurityContext` — runAsUser, runAsGroup, runAsNonRoot, fsGroup, seccompProfile
- `dnsPolicy` + `dnsConfig` — nameservers[], searches[], options[]
- `hostAliases` — array of {ip, hostnames}
- `hostNetwork`, `hostPID`, `hostIPC` — booleans
- `podAffinity` — enabled, type, topologyKey, labelKey, labelValue, strength

### 2. Add/Remove Functions
Added 8 functions after `removeToleration`:
- `addDnsNameserver` / `removeDnsNameserver`
- `addDnsSearch` / `removeDnsSearch`
- `addDnsOption` / `removeDnsOption`
- `addHostAlias` / `removeHostAlias`

### 3. YAML Generation
Inserted before `containers:` block in `previewYAML` computed:
- Pod-level securityContext (guarded by non-empty check)
- dnsPolicy + dnsConfig (nameservers/searches/options)
- hostAliases (with comma-split hostnames)
- hostNetwork / hostPID / hostIPC (conditional true)
- podAffinity / podAntiAffinity (required + preferred, with labelSelector + topologyKey)

### 4. Step 4 Template
- Renamed h3 from "调度与更新策略" to "高级设置"
- Added 6 new sections after PriorityClass:
  - ServiceAccount (select for SA + Image Pull Secret)
  - Pod Security Context (runAsUser, runAsGroup, fsGroup, runAsNonRoot checkbox, seccompProfile select)
  - DNS Config (dnsPolicy select + nameservers/searches/options array editors)
  - Host Aliases (ip + hostnames comma-separated)
  - Host Network (3 checkboxes)
  - Pod Affinity/Anti-Affinity (enable toggle + type/strength/topologyKey/labelKey/labelValue)

## Build Output

```
vite v8.0.16 building client environment for production...
✓ 171 modules transformed.
dist/assets/DeployApp-CKjtxwXK.js  99.76 kB │ gzip: 19.19 kB
✓ built in 13.91s
```

Build passes with zero errors. DeployApp chunk grew from ~95 kB to ~100 kB (expected for the new form sections).
