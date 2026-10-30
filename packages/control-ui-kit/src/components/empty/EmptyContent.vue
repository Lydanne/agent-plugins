<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="empty-content"
    :class="cn(
      'ocp:flex ocp:w-full ocp:min-w-0 ocp:max-w-sm ocp:flex-col ocp:items-center ocp:gap-4 ocp:text-balance ocp:text-sm',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
