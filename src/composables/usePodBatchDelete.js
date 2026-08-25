// src/composables/usePodBatchDelete.js
// Pod 卡片批量删除(NsPods 列表 / NsWorkloadDetail Pods tab 共用):
// 选中集 Set 跨筛选/分页保留;batchTargets 按 universe 存在性校验(列表刷新/被删的自动失效);
// allSettled+summarizeResults 汇总——全成清空退出,部分败保留失败选中便于重试。
import { ref, computed, unref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import { summarizeResults } from '@/utils/batchDelete'

export function usePodBatchDelete({ universe, candidates, getNamespace, onOpen }) {
  const { t } = useI18n()
  const store = useClusterStore()
  const val = x => (typeof x === 'function' ? x() : unref(x))

  const batchMode = ref(false)
  const selectedNames = ref(new Set())
  const showBatchModal = ref(false)
  function toggleSelect(name) {
    const s = selectedNames.value
    if (s.has(name)) s.delete(name)
    else s.add(name)
  }
  function enterBatch() { batchMode.value = true }
  function exitBatch() { batchMode.value = false; selectedNames.value = new Set() }
  function selectAllCandidates() {
    selectedNames.value = new Set(val(candidates).map(p => p.name))
  }
  function clearSelection() { selectedNames.value = new Set() }
  const batchTargets = computed(() => val(universe).filter(p => selectedNames.value.has(p.name)))
  const batchNamesPreview = computed(() => {
    const names = batchTargets.value.map(p => p.name)
    const head = names.slice(0, 10).join(', ')
    return names.length > 10 ? `${head} ${t('ns.pods.batchMoreNames', { n: names.length - 10 })}` : head
  })
  function onCardClick(p) {
    if (batchMode.value) { toggleSelect(p.name); return }
    onOpen(p)
  }
  async function handleBatchDelete() {
    const targets = batchTargets.value
    if (!targets.length) return
    const ns = getNamespace()
    const results = await Promise.allSettled(targets.map(p => store.deletePod(p.name, ns)))
    const { okNames, failedNames } = summarizeResults(results, targets)
    if (!failedNames.length) {
      notify('success', t('ns.pods.batchDeleted', { n: okNames.length }))
      showBatchModal.value = false
      exitBatch()
    } else {
      // 部分失败:保留失败项选中便于重试;不退出批量模式
      notify('error', t('ns.pods.batchPartial', { ok: okNames.length, fail: failedNames.length, names: failedNames.length > 5
        ? `${failedNames.slice(0, 5).join(', ')} ${t('ns.pods.batchMoreNames', { n: failedNames.length - 5 })}`
        : failedNames.join(', ') }))
      selectedNames.value = new Set(failedNames)
      showBatchModal.value = false
    }
  }
  return { batchMode, selectedNames, showBatchModal, toggleSelect, enterBatch, exitBatch, selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete }
}
