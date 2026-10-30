<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="alert-description"
    :class="cn('ocp:text-muted-foreground ocp:col-start-2 ocp:text-sm ocp:[&_p]:leading-relaxed', props.class)"
  >
    <slot />
  </div>
</template>
