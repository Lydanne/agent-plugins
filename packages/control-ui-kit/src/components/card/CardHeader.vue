<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card-header"
    :class="cn('ocp:@container/card-header ocp:grid ocp:auto-rows-min ocp:grid-rows-[auto_auto] ocp:items-start ocp:gap-1.5 ocp:px-6 ocp:has-data-[slot=card-action]:grid-cols-[1fr_auto] ocp:[.border-b]:pb-6', props.class)"
  >
    <slot />
  </div>
</template>
