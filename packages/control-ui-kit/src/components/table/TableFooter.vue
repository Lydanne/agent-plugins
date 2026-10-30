<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tfoot
    data-slot="table-footer"
    :class="cn('ocp:bg-muted/50 ocp:border-t ocp:font-medium ocp:[&>tr]:last:border-b-0', props.class)"
  >
    <slot />
  </tfoot>
</template>
