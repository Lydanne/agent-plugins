<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

defineOptions({inheritAttrs:false});
const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div data-slot="table-container" class="ocp:relative ocp:w-full ocp:overflow-auto">
    <table v-bind="$attrs" data-slot="table" :class="cn('ocp:w-full ocp:caption-bottom ocp:text-sm', props.class)">
      <slot />
    </table>
  </div>
</template>
