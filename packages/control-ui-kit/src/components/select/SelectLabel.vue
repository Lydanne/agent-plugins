<script setup lang="ts">
import type { SelectLabelProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"
import { SelectLabel } from "reka-ui"

const props = defineProps<SelectLabelProps & { class?: HTMLAttributes["class"] }>()
</script>

<template>
  <SelectLabel
    data-slot="select-label"
    :class="cn('ocp:text-muted-foreground ocp:px-2 ocp:py-1.5 ocp:text-xs', props.class)"
  >
    <slot />
  </SelectLabel>
</template>
