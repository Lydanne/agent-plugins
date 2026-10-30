<script setup lang="ts">
import type { PaginationEllipsisProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { MoreHorizontal } from "../../icons"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { PaginationEllipsis } from "reka-ui"

const props = defineProps<PaginationEllipsisProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <PaginationEllipsis
    data-slot="pagination-ellipsis"
    v-bind="delegatedProps"
    :class="cn('ocp:flex ocp:size-9 ocp:items-center ocp:justify-center', props.class)"
  >
    <slot>
      <MoreHorizontal class="ocp:size-4" />
      <span class="ocp:sr-only">More pages</span>
    </slot>
  </PaginationEllipsis>
</template>
