<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="alert-title"
    :class="cn('ocp:col-start-2 ocp:line-clamp-1 ocp:min-h-4 ocp:font-medium ocp:tracking-tight', props.class)"
  >
    <slot />
  </div>
</template>
