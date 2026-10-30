<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="alert-dialog-header"
    :class="cn('ocp:flex ocp:flex-col ocp:gap-2 ocp:text-center ocp:sm:text-left', props.class)"
  >
    <slot />
  </div>
</template>
