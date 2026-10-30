<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="empty-title"
    :class="cn('ocp:text-lg ocp:font-medium ocp:tracking-tight', props.class)"
  >
    <slot />
  </div>
</template>
