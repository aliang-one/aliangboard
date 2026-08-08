import { ref } from 'vue'

// 模块级单例:CopyWorkloadDialog setSeed → 跳转 → DeployApp setup consumeSeed(取出即清空)。
const seed = ref(null)

export function useCopySeed() {
  function setSeed(value) { seed.value = value }
  function consumeSeed() {
    const v = seed.value
    seed.value = null
    return v
  }
  function hasSeed() { return seed.value != null }
  return { setSeed, consumeSeed, hasSeed, seed }
}
