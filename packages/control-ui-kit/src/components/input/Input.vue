<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "../../utils"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    :class="cn(
      'ocp:file:text-foreground ocp:placeholder:text-muted-foreground ocp:selection:bg-primary ocp:selection:text-primary-foreground ocp:border-input ocp:h-9 ocp:w-full ocp:min-w-0 ocp:rounded-md ocp:border ocp:bg-transparent ocp:px-3 ocp:py-1 ocp:text-base ocp:shadow-xs ocp:transition-[color,box-shadow] ocp:outline-none ocp:file:inline-flex ocp:file:h-7 ocp:file:border-0 ocp:file:bg-transparent ocp:file:text-sm ocp:file:font-medium ocp:disabled:pointer-events-none ocp:disabled:cursor-not-allowed ocp:disabled:opacity-50 ocp:md:text-sm',
      'ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:focus-visible:ring-3',
      'ocp:aria-invalid:ring-destructive/20 ocp:aria-invalid:border-destructive',
      props.class,
    )"
  >
</template>
