<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="empty"
    :class="cn(
      'ocp:flex ocp:min-w-0 ocp:flex-1 ocp:flex-col ocp:items-center ocp:justify-center ocp:gap-6 ocp:text-balance ocp:rounded-lg ocp:border-dashed ocp:p-6 ocp:text-center ocp:md:p-12',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
