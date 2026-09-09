<script>
// 手机虚拟按键字节表(VT100/xterm 标准):无物理键盘时的终端刚需(spec §5;
// Wave5 B6 自 InteractiveTerminal 抽出,pod exec 与 SSH 终端同源)。纯数据,供模板 v-for 与测试直测。
export const KEY_BYTES = { 'Esc': '\x1b', 'Tab': '\t', '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C', 'Ctrl+C': '\x03' }
</script>

<script setup>
// 手机档虚拟按键条(Wave5 B6 自 InteractiveTerminal 抽出共享):组件持有键位表与键钮样式;
// 消费方供 send 回调(须与其终端自身键盘同通路,即 stream.send)+ 渲染后的回焦(xterm.focus,
// 均为消费方侧职责);字号钮(A-/A+)等前置件经默认槽注入,渲染在 7 键之前(pod 既有布局)。
defineProps({
  // send(bytes):按键字节串下发,消费方内部走 term.onData 同款数据通路并回焦收软键盘
  send: { type: Function, required: true },
})
</script>

<template>
  <div data-test="term-keybar" class="flex items-center gap-1 px-sm py-1 border-t border-outline-variant bg-surface-container-low overflow-x-auto shrink-0">
    <slot></slot>
    <button v-for="(bytes, key) in KEY_BYTES" :key="key" @pointerdown.prevent @click="send(bytes)"
      class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono active:bg-primary-container/20 transition-colors">
      {{ key }}
    </button>
  </div>
</template>
