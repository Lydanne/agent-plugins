<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <div
    data-slot="sheet-header"
    :class="cn('ocp:flex ocp:flex-col ocp:gap-1.5 ocp:p-4', props.class)"
  >
    <slot />
  </div>
</template>
