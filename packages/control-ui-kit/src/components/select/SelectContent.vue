<script setup lang="ts">
import {useOverlayTarget} from "../../host"
const overlayTarget=useOverlayTarget()
import type { SelectContentEmits, SelectContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  useForwardPropsEmits,
} from "reka-ui"
import { SelectScrollDownButton, SelectScrollUpButton } from "."

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    position: "popper",
  },
)
const emits = defineEmits<SelectContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SelectPortal :to="overlayTarget">
    <SelectContent
      data-slot="select-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn(
        'ocp:bg-popover ocp:text-popover-foreground ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=open]:fade-in-0 ocp:data-[state=closed]:zoom-out-95 ocp:data-[state=open]:zoom-in-95 ocp:data-[side=bottom]:slide-in-from-top-2 ocp:data-[side=left]:slide-in-from-right-2 ocp:data-[side=right]:slide-in-from-left-2 ocp:data-[side=top]:slide-in-from-bottom-2 ocp:relative ocp:z-50 ocp:max-h-(--reka-select-content-available-height) ocp:min-w-[8rem] ocp:overflow-x-hidden ocp:overflow-y-auto ocp:rounded-md ocp:border ocp:shadow-md',
        position === 'popper'
          && 'ocp:data-[side=bottom]:translate-y-1 ocp:data-[side=left]:-translate-x-1 ocp:data-[side=right]:translate-x-1 ocp:data-[side=top]:-translate-y-1',
        props.class,
      )
      "
    >
      <SelectScrollUpButton />
      <SelectViewport :class="cn('ocp:p-1', position === 'popper' && 'ocp:h-(--reka-select-trigger-height) ocp:w-full ocp:min-w-(--reka-select-trigger-width) ocp:scroll-my-1')">
        <slot />
      </SelectViewport>
      <SelectScrollDownButton />
    </SelectContent>
  </SelectPortal>
</template>
