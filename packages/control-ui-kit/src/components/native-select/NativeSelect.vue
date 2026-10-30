<script setup lang="ts">
import type { AcceptableValue } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit, useVModel } from "@vueuse/core"
import { cn } from "../../utils"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<{ modelValue?: AcceptableValue | AcceptableValue[], class?: HTMLAttributes["class"] }>()

const emit = defineEmits<{
  "update:modelValue": [value: AcceptableValue]
}>()

const modelValue = useVModel(props, "modelValue", emit, {
  passive: true,
  defaultValue: "",
})

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <div
    class="ocp:group/native-select ocp:relative ocp:w-fit ocp:min-w-0 ocp:max-w-full ocp:has-[select:disabled]:opacity-50"
    data-slot="native-select-wrapper"
  >
    <select
      v-bind="{ ...$attrs, ...delegatedProps }"
      v-model="modelValue"
      data-slot="native-select"
      :class="cn(
        'ocp:border-input ocp:placeholder:text-muted-foreground ocp:selection:bg-primary ocp:selection:text-primary-foreground ocp:h-9 ocp:w-full ocp:min-w-0 ocp:appearance-none ocp:rounded-md ocp:border ocp:bg-transparent ocp:px-3 ocp:py-2 ocp:pr-9 ocp:text-sm ocp:shadow-xs ocp:transition-[color,box-shadow] ocp:outline-none ocp:disabled:pointer-events-none ocp:disabled:cursor-not-allowed',
        'ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:focus-visible:ring-3',
        'ocp:aria-invalid:ring-destructive/20 ocp:aria-invalid:border-destructive',
        props.class,
      )"
    >
      <slot />
    </select>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      class="ocp:text-muted-foreground ocp:pointer-events-none ocp:absolute ocp:top-1/2 ocp:right-3.5 ocp:size-4 ocp:-translate-y-1/2 ocp:opacity-50 ocp:select-none"
      aria-hidden="true"
      data-slot="native-select-icon"
    ><path d="m6 9 6 6 6-6" /></svg>
  </div>
</template>
