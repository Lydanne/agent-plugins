<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <div
    data-slot="sheet-footer"
    :class="cn('ocp:mt-auto ocp:flex ocp:flex-col ocp:gap-2 ocp:p-4', props.class)
    "
  >
    <slot />
  </div>
</template>
