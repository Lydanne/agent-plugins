<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { Check } from "../../icons"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { CheckboxIndicator, CheckboxRoot, useForwardPropsEmits } from "reka-ui"

const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<CheckboxRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <CheckboxRoot
    v-slot="slotProps"
    data-slot="checkbox"
    v-bind="forwarded"
    :class="
      cn('ocp:peer ocp:border-input ocp:data-[state=checked]:bg-primary ocp:data-[state=checked]:text-primary-foreground ocp:data-[state=checked]:border-primary ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:aria-invalid:ring-destructive/20 ocp:aria-invalid:border-destructive ocp:size-4 ocp:shrink-0 ocp:rounded-[4px] ocp:border ocp:shadow-xs ocp:transition-shadow ocp:outline-none ocp:focus-visible:ring-3 ocp:disabled:cursor-not-allowed ocp:disabled:opacity-50',
         props.class)"
  >
    <CheckboxIndicator
      data-slot="checkbox-indicator"
      class="ocp:grid ocp:place-content-center ocp:text-current ocp:transition-none"
    >
      <slot v-bind="slotProps">
        <Check class="ocp:size-3.5" />
      </slot>
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
