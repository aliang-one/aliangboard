// 斜杠命令面板数据(2026-08-28 spec D3):剧本=可编辑插入的完整提示词;动作=直接执行。
// 纯数据+纯过滤,无 Vue 依赖;文案键指向 locales 的 workbench.chat.slash.*。
export const SLASH_ACTIONS = [
  { id: 'compact', icon: 'bolt', nameKey: 'workbench.chat.slash.actCompact', descKey: 'workbench.chat.slash.actCompactDesc',
    enabled: state => !!state?.canCompact },
]

export const PLAYBOOKS = [
  { id: 'imagepull', icon: 'description', nameKey: 'workbench.chat.slash.pb.imagepull.name', descKey: 'workbench.chat.slash.pb.imagepull.desc', bodyKey: 'workbench.chat.slash.pb.imagepull.body' },
  { id: 'crashloop', icon: 'description', nameKey: 'workbench.chat.slash.pb.crashloop.name', descKey: 'workbench.chat.slash.pb.crashloop.desc', bodyKey: 'workbench.chat.slash.pb.crashloop.body' },
  { id: 'pending', icon: 'description', nameKey: 'workbench.chat.slash.pb.pending.name', descKey: 'workbench.chat.slash.pb.pending.desc', bodyKey: 'workbench.chat.slash.pb.pending.body' },
  { id: 'svc-unreachable', icon: 'hub', nameKey: 'workbench.chat.slash.pb.svcunreachable.name', descKey: 'workbench.chat.slash.pb.svcunreachable.desc', bodyKey: 'workbench.chat.slash.pb.svcunreachable.body' },
  { id: 'rollout-stuck', icon: 'rocket_launch', iconFallback: 'description', nameKey: 'workbench.chat.slash.pb.rolloutstuck.name', descKey: 'workbench.chat.slash.pb.rolloutstuck.desc', bodyKey: 'workbench.chat.slash.pb.rolloutstuck.body' },
  { id: 'quota', icon: 'prohibit', nameKey: 'workbench.chat.slash.pb.quota.name', descKey: 'workbench.chat.slash.pb.quota.desc', bodyKey: 'workbench.chat.slash.pb.quota.body' },
  { id: 'capacity', icon: 'memory', nameKey: 'workbench.chat.slash.pb.capacity.name', descKey: 'workbench.chat.slash.pb.capacity.desc', bodyKey: 'workbench.chat.slash.pb.capacity.body' },
  { id: 'oomkilled', icon: 'warning', nameKey: 'workbench.chat.slash.pb.oomkilled.name', descKey: 'workbench.chat.slash.pb.oomkilled.desc', bodyKey: 'workbench.chat.slash.pb.oomkilled.body' },
  { id: 'dns', icon: 'dns', nameKey: 'workbench.chat.slash.pb.dns.name', descKey: 'workbench.chat.slash.pb.dns.desc', bodyKey: 'workbench.chat.slash.pb.dns.body' },
  { id: 'health-sweep', icon: 'health_and_safety', nameKey: 'workbench.chat.slash.pb.healthsweep.name', descKey: 'workbench.chat.slash.pb.healthsweep.desc', bodyKey: 'workbench.chat.slash.pb.healthsweep.body' },
]

// query=行首 / 后的输入(可空);小写子串匹配 id;动作恒在前(被过滤同样适用)
export function filterSlashItems(query) {
  const q = String(query || '').toLowerCase()
  const match = item => !q || item.id.toLowerCase().includes(q)
  return [...SLASH_ACTIONS.filter(match), ...PLAYBOOKS.filter(match)]
}
