<script setup>
// 悬浮入口的对话 Modal:Modal 壳 + 内嵌可复用 WorkbenchChat(自带 SSE 流式/审批/看门狗/重新生成全套)。
// 哑壳:只负责布局与关闭;readAt 刷新/轮询由 ChatPresence 统一管理(单一写入点)。
// 「挂到后台」按钮在此不出现——Modal 本身就是后台形态(spec §2.3)。
import { computed } from 'vue'
import Modal from '@/components/common/Modal.vue'
import WorkbenchChat from './WorkbenchChat.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  conversation: { type: Object, default: null }, // { id, projectId, projectName, title, ... }
})
const emit = defineEmits(['update:modelValue'])

const headerTitle = computed(() => {
  if (!props.conversation) return ''
  const { projectName, title } = props.conversation
  return title ? `${projectName} · ${title}` : projectName
})
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="headerTitle"
    width="!w-[min(1080px,92vw)] max-w-none"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <!-- Modal 槽区自带 p-lg + max-h-[90vh];内层定高让 WorkbenchChat 自管滚动。
         width 用 ! 前缀压过 Modal 默认 w-full/max-w-lg 的类冲突,取大横幅。 -->
    <div v-if="conversation" class="h-[72vh] flex flex-col min-h-0">
      <WorkbenchChat
        :key="conversation.id"
        :project-id="conversation.projectId"
        :project-name="conversation.projectName"
        :conversation-id="conversation.id"
        :active-conversation-id="conversation.id"
      />
    </div>
  </Modal>
</template>
