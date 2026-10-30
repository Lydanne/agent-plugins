import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

export const badgeVariants = cva(
  "ocp:inline-flex ocp:items-center ocp:justify-center ocp:rounded-full ocp:border ocp:px-2 ocp:py-0.5 ocp:text-xs ocp:font-medium ocp:w-fit ocp:whitespace-nowrap ocp:shrink-0 ocp:[&>svg]:size-3 ocp:gap-1 ocp:[&>svg]:pointer-events-none ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:focus-visible:ring-3 ocp:aria-invalid:ring-destructive/20 ocp:aria-invalid:border-destructive ocp:transition-[color,box-shadow] ocp:overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "ocp:border-transparent ocp:bg-primary ocp:text-primary-foreground ocp:[a&]:hover:bg-primary/90",
        secondary:
          "ocp:border-transparent ocp:bg-secondary ocp:text-secondary-foreground ocp:[a&]:hover:bg-secondary/90",
        destructive:
         "ocp:border-transparent ocp:bg-destructive ocp:text-white ocp:[a&]:hover:bg-destructive/90 ocp:focus-visible:ring-destructive/20",
        outline:
          "ocp:text-foreground ocp:[a&]:hover:bg-accent ocp:[a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
