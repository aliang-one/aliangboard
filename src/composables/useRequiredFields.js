// 表单必填字段校验(轻量):API Key 签发表单校验模式的通用化。
// 服务端 400「缺少必填字段」只落一个 toast、表单上无从辨认缺哪项——
// 统一改为提交前客户端拦截:不发请求 + 行内红字(data-testid="form-error-<field>")。
// 服务端校验保留为最后防线(本 composable 不替代它)。
import { ref } from 'vue'

// validate(form, required):required 中 trim 后为空的字段填进 errors,返回是否全通过。
// 字段值先 String() 再 trim——null/undefined/数字都安全。
export function useRequiredFields() {
  const errors = ref({})

  function validate(form, required) {
    errors.value = Object.fromEntries(
      required.filter(k => !String(form?.[k] ?? '').trim()).map(k => [k, true])
    )
    return !Object.keys(errors.value).length
  }

  // 单字段清除(输入即消红);不存在时 no-op
  function clear(k) { if (errors.value[k]) delete errors.value[k] }
  function reset() { errors.value = {} }

  return { errors, validate, clear, reset }
}
