// 从 NsConfigMapDetail 内联实现抽出（详情页本体暂保留内联版，见 spec follow-up）

export function detectLang(key) {
  const k = (key || '').toLowerCase()
  if (k.endsWith('.yml') || k.endsWith('.yaml')) return { label: 'YAML', icon: 'data_object', color: 'bg-primary-container/10 text-primary', prismLang: 'yaml' }
  if (k.endsWith('.json')) return { label: 'JSON', icon: 'data_object', color: 'bg-tertiary-container/10 text-tertiary', prismLang: 'json' }
  if (k.endsWith('.toml')) return { label: 'TOML', icon: 'settings', color: 'bg-secondary-container/10 text-secondary', prismLang: 'toml' }
  if (k.endsWith('.conf') || k.endsWith('.cfg') || k.endsWith('.cnf') || k.endsWith('.ini')) return { label: 'CONF', icon: 'settings', color: 'bg-secondary-container/10 text-secondary', prismLang: 'ini' }
  if (k.endsWith('.properties')) return { label: 'PROPS', icon: 'list_alt', color: 'bg-secondary-container/10 text-secondary', prismLang: 'properties' }
  if (k.endsWith('.sh') || k.endsWith('.bash')) return { label: 'SHELL', icon: 'terminal', color: 'bg-tertiary-container/10 text-tertiary', prismLang: 'bash' }
  if (k.endsWith('.py')) return { label: 'PYTHON', icon: 'code', color: 'bg-primary-container/10 text-primary', prismLang: 'python' }
  if (k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.jsx')) return { label: 'JS', icon: 'code', color: 'bg-tertiary-container/10 text-tertiary', prismLang: 'javascript' }
  if (k.endsWith('.ts') || k.endsWith('.tsx')) return { label: 'TS', icon: 'code', color: 'bg-primary-container/10 text-primary', prismLang: 'typescript' }
  if (k.endsWith('.xml')) return { label: 'XML', icon: 'code', color: 'bg-secondary-container/10 text-secondary', prismLang: 'markup' }
  if (k.endsWith('.env')) return { label: 'ENV', icon: 'code', color: 'bg-primary-container/10 text-primary', prismLang: 'properties' }
  if (k.endsWith('.crt') || k.endsWith('.key') || k.endsWith('.pem') || k.endsWith('.ca')) return { label: 'CERT', icon: 'lock', color: 'bg-error-container/10 text-error', prismLang: 'none' }
  return { label: 'TEXT', icon: 'description', color: 'bg-surface-container text-on-surface-variant', prismLang: 'none' }
}

export function lineCount(val) {
  return val ? String(val).split('\n').length : 0
}
