<script setup>
// LLM 配置(admin):设 baseURL / apiKey / model,存 DB(平台 agent 用)。DB 优先、env 回退。
// GET 不回传 key(只回状态),apiKey 留空 = 不修改。「测试连接」用当前配置 ping 一下验证。
import { ref, computed, onMounted } from 'vue'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const status = ref(null)       // GET 回的当前有效配置 + 各字段来源
const form = ref({ baseURL: '', model: '', apiKey: '' })
const saving = ref(false)
const testing = ref(false)
const testResult = ref(null)   // { ok, reply? | message? }
const loading = ref(true)

const SOURCE_STYLE = { db: 'bg-status-running/10 text-status-running', env: 'bg-surface-container-high text-on-surface-variant', none: 'bg-error/10 text-error' }
const SOURCE_LABEL = { db: '数据库', env: '环境变量', none: '未配置' }

const apiKeyLabel = computed(() => {
  if (!status.value) return ''
  if (!status.value.hasApiKey) return '未设置'
  return `已设置(${SOURCE_LABEL[status.value.apiKeySource]})`
})

async function load() {
  loading.value = true
  try {
    const s = await adminApi.llmConfig.get()
    status.value = s
    form.value.baseURL = s.baseURL || ''
    form.value.model = s.model || ''
    form.value.apiKey = ''
  } catch (e) {
    notify('error', e.message || '加载失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function save() {
  saving.value = true
  try {
    const payload = { baseURL: form.value.baseURL.trim(), model: form.value.model.trim() }
    if (form.value.apiKey) payload.apiKey = form.value.apiKey  // 留空不传 = 不修改
    await adminApi.llmConfig.save(payload)
    notify('success', '已保存')
    form.value.apiKey = ''
    await load()
  } catch (e) {
    notify('error', e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function testConn() {
  testing.value = true
  testResult.value = null
  try {
    const r = await adminApi.llmConfig.test({ baseURL: form.value.baseURL.trim(), model: form.value.model.trim(), apiKey: form.value.apiKey })
    testResult.value = r
    if (r.ok) notify('success', '连接成功')
    else notify('error', r.message || '连接失败')
  } catch (e) {
    testResult.value = { ok: false, message: e.message || '连接失败' }
    notify('error', e.message || '连接失败')
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <section class="animate-fade-in p-md max-w-3xl flex flex-col gap-md">
    <div>
      <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm">
        <span class="material-symbols-outlined">neurology</span> LLM 配置
      </h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">平台内置 agent 用此配置调 OpenAI 兼容模型(DeepSeek / Qwen / Ollama / vLLM 等)。存数据库、DB 优先、环境变量(LLM_BASE_URL/LLM_API_KEY/LLM_MODEL)回退。</p>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <template v-else>
      <!-- 当前有效配置状态 -->
      <div class="bg-surface-container-low border border-outline-variant rounded-lg p-md">
        <p class="text-label-caps text-on-surface-variant mb-sm">当前生效配置</p>
        <div class="grid grid-cols-3 gap-md text-body-sm">
          <div><p class="text-on-surface-variant text-body-xs mb-xs">baseURL</p>
            <p class="font-mono break-all">{{ status?.baseURL || '—' }}</p>
            <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="SOURCE_STYLE[status?.baseURLSource]">{{ SOURCE_LABEL[status?.baseURLSource] }}</span>
          </div>
          <div><p class="text-on-surface-variant text-body-xs mb-xs">model</p>
            <p class="font-mono break-all">{{ status?.model || '—' }}</p>
            <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="SOURCE_STYLE[status?.modelSource]">{{ SOURCE_LABEL[status?.modelSource] }}</span>
          </div>
          <div><p class="text-on-surface-variant text-body-xs mb-xs">API Key</p>
            <p class="flex items-center gap-xs">
              <span class="w-1.5 h-1.5 rounded-full inline-block" :class="status?.hasApiKey ? 'bg-status-running' : 'bg-error'"></span>
              {{ apiKeyLabel }}
            </p>
            <span v-if="status?.hasApiKey" class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="SOURCE_STYLE[status?.apiKeySource]">{{ SOURCE_LABEL[status?.apiKeySource] }}</span>
          </div>
        </div>
      </div>

      <!-- 编辑表单 -->
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md flex flex-col gap-md">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">baseURL(OpenAI 兼容根地址)</label>
          <input v-model="form.baseURL" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">model</label>
          <input v-model="form.model" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="deepseek-chat" />
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Key</label>
          <input v-model="form.apiKey" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="留空表示不修改" />
          <p class="text-body-xs text-on-surface-variant mt-xs">明文存储(等同集群 token)。留空保存则保持现有 key 不变。</p>
        </div>
        <div class="flex items-center gap-sm">
          <button @click="save" :disabled="saving" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">
            <span class="material-symbols-outlined text-base">save</span> {{ saving ? '保存中…' : '保存' }}
          </button>
          <button @click="testConn" :disabled="testing" class="flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container disabled:opacity-40">
            <span class="material-symbols-outlined text-base">{{ testing ? 'progress_activity' : 'cable' }}</span> {{ testing ? '测试中…' : '测试连接' }}
          </button>
        </div>
        <div v-if="testResult" class="rounded-lg p-sm text-body-sm flex items-start gap-xs" :class="testResult.ok ? 'bg-status-running/10 text-status-running' : 'bg-error/5 text-error border border-error/20'">
          <span class="material-symbols-outlined text-base mt-0.5">{{ testResult.ok ? 'check_circle' : 'error' }}</span>
          <div class="min-w-0">
            <p>{{ testResult.ok ? '连接成功' : '连接失败' }}</p>
            <p v-if="testResult.ok && testResult.reply" class="font-mono text-body-xs text-on-surface-variant break-all">回复:{{ testResult.reply }}</p>
            <p v-if="!testResult.ok && testResult.message" class="font-mono text-body-xs break-all">{{ testResult.message }}</p>
          </div>
        </div>
      </div>

      <!-- 示例 -->
      <div class="bg-surface-container-low border border-outline-variant rounded-lg p-md">
        <p class="text-label-caps text-on-surface-variant mb-sm">常见 baseURL</p>
        <ul class="text-body-sm text-on-surface-variant flex flex-col gap-xs font-mono">
          <li>DeepSeek: <span class="text-on-surface">https://api.deepseek.com/v1</span> · model: deepseek-chat</li>
          <li>Qwen(百炼): <span class="text-on-surface">https://dashscope.aliyuncs.com/compatible-mode/v1</span></li>
          <li>Ollama(本地): <span class="text-on-surface">http://localhost:11434/v1</span> · API Key 随意填</li>
          <li>OpenAI: <span class="text-on-surface">https://api.openai.com/v1</span></li>
        </ul>
      </div>
    </template>
  </section>
</template>
