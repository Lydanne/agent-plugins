<script setup lang="ts">
import type { DropdownMenuSubContentEmits, DropdownMenuSubContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import {
  DropdownMenuSubContent,
  useForwardPropsEmits,
} from "reka-ui"

const props = defineProps<DropdownMenuSubContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuSubContent
    data-slot="dropdown-menu-sub-content"
    v-bind="forwarded"
    :class="cn('ocp:bg-popover ocp:text-popover-foreground ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=open]:fade-in-0 ocp:data-[state=closed]:zoom-out-95 ocp:data-[state=open]:zoom-in-95 ocp:data-[side=bottom]:slide-in-from-top-2 ocp:data-[side=left]:slide-in-from-right-2 ocp:data-[side=right]:slide-in-from-left-2 ocp:data-[side=top]:slide-in-from-bottom-2 ocp:z-50 ocp:min-w-[8rem] ocp:max-w-(--reka-dropdown-menu-content-available-width) ocp:origin-(--reka-dropdown-menu-content-transform-origin) ocp:overflow-hidden ocp:rounded-md ocp:border ocp:p-1 ocp:shadow-lg', props.class)"
  >
    <slot />
  </DropdownMenuSubContent>
</template>
