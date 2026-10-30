<script setup lang="ts">
import {useOverlayTarget} from "../../host"
const overlayTarget=useOverlayTarget()
import type { DropdownMenuContentEmits, DropdownMenuContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  useForwardPropsEmits,
} from "reka-ui"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<DropdownMenuContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    sideOffset: 4,
  },
)
const emits = defineEmits<DropdownMenuContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuPortal :to="overlayTarget">
    <DropdownMenuContent
      data-slot="dropdown-menu-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('ocp:bg-popover ocp:text-popover-foreground ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=open]:fade-in-0 ocp:data-[state=closed]:zoom-out-95 ocp:data-[state=open]:zoom-in-95 ocp:data-[side=bottom]:slide-in-from-top-2 ocp:data-[side=left]:slide-in-from-right-2 ocp:data-[side=right]:slide-in-from-left-2 ocp:data-[side=top]:slide-in-from-bottom-2 ocp:z-50 ocp:max-h-(--reka-dropdown-menu-content-available-height) ocp:min-w-[8rem] ocp:origin-(--reka-dropdown-menu-content-transform-origin) ocp:overflow-x-hidden ocp:overflow-y-auto ocp:rounded-md ocp:border ocp:p-1 ocp:shadow-md', props.class)"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
