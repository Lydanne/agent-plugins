<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="empty-header"
    :class="cn(
      'ocp:flex ocp:max-w-sm ocp:flex-col ocp:items-center ocp:gap-2 ocp:text-center',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
