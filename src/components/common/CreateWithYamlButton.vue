<script setup>
// 「创建」按钮黏合层:SplitButton(主=表单创建,次=从 YAML 创建)+ 自持 CreateFromYamlDialog。
// 单根 div:多根组件不继承 attrs,NamespaceOverview 空态的 class="mt-md" 需要落点。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SplitButton from '@/components/common/SplitButton.vue'
import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: 'add' },
  mainAction: { type: Function, default: undefined },
  mainOpensYaml: { type: Boolean, default: false }, // 主按钮直开 YAML 弹窗(无表单创建的 tab 用)
  yamlTemplate: { type: String, default: 'Deployment' },
  namespace: { type: String, default: '' },
  extraItems: { type: Array, default: () => [] }, // 追加在「从 YAML 创建」之后
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['applied'])

const { t } = useI18n()
const showYaml = ref(false)

function openYaml() { showYaml.value = true }
function onMain() { if (props.mainOpensYaml) openYaml(); else if (props.mainAction) props.mainAction() }
</script>

<template>
  <div>
    <SplitButton
      :label="label"
      :icon="icon"
      :main-action="onMain"
      :items="[
        { label: t('component.splitButton.createFromYaml'), icon: 'description', action: openYaml },
        ...extraItems,
      ]"
      :disabled="disabled"
    />
    <CreateFromYamlDialog v-model="showYaml" :kind="yamlTemplate" :namespace="namespace" @applied="emit('applied')" />
  </div>
</template>
