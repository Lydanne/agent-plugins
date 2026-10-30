<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import TableCell from "./TableCell.vue"
import TableRow from "./TableRow.vue"

const props = withDefaults(defineProps<{
  class?: HTMLAttributes["class"]
  colspan?: number
}>(), {
  colspan: 1,
})

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <TableRow>
    <TableCell
      :class="
        cn(
          'ocp:p-4 ocp:whitespace-nowrap ocp:align-middle ocp:text-sm ocp:text-foreground',
          props.class,
        )
      "
      v-bind="delegatedProps"
    >
      <div class="ocp:flex ocp:items-center ocp:justify-center ocp:py-10">
        <slot />
      </div>
    </TableCell>
  </TableRow>
</template>
