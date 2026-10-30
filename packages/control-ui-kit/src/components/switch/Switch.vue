<script setup lang="ts">
import type { SwitchRootEmits, SwitchRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import {
  SwitchRoot,
  SwitchThumb,
  useForwardPropsEmits,
} from "reka-ui"

const props = defineProps<SwitchRootProps & { class?: HTMLAttributes["class"] }>()

const emits = defineEmits<SwitchRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SwitchRoot
    v-slot="slotProps"
    data-slot="switch"
    v-bind="forwarded"
    :class="cn(
      'ocp:peer ocp:data-[state=checked]:bg-primary ocp:data-[state=unchecked]:bg-input ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:inline-flex ocp:h-[1.15rem] ocp:w-8 ocp:shrink-0 ocp:items-center ocp:rounded-full ocp:border ocp:border-transparent ocp:shadow-xs ocp:transition-all ocp:outline-none ocp:focus-visible:ring-3 ocp:disabled:cursor-not-allowed ocp:disabled:opacity-50',
      props.class,
    )"
  >
    <SwitchThumb
      data-slot="switch-thumb"
      :class="cn('ocp:bg-background ocp:pointer-events-none ocp:block ocp:size-4 ocp:rounded-full ocp:ring-0 ocp:transition-transform ocp:data-[state=checked]:translate-x-[calc(100%-2px)] ocp:data-[state=unchecked]:translate-x-0')"
    >
      <slot name="thumb" v-bind="slotProps" />
    </SwitchThumb>
  </SwitchRoot>
</template>
