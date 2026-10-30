import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "ocp:inline-flex ocp:items-center ocp:justify-center ocp:gap-2 ocp:whitespace-nowrap ocp:rounded-md ocp:text-sm ocp:font-medium ocp:transition-all ocp:disabled:pointer-events-none ocp:disabled:opacity-50 ocp:[&_svg]:pointer-events-none ocp:[&_svg:not([class*='size-'])]:size-4 ocp:shrink-0 ocp:[&_svg]:shrink-0 ocp:outline-none ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:focus-visible:ring-3 ocp:aria-invalid:ring-destructive/20 ocp:aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "ocp:bg-primary ocp:text-primary-foreground ocp:hover:bg-primary/90",
        destructive:
          "ocp:bg-destructive ocp:text-white ocp:hover:bg-destructive/90 ocp:focus-visible:ring-destructive/20 ",
        outline:
          "ocp:border ocp:bg-background ocp:shadow-xs ocp:hover:bg-accent ocp:hover:text-accent-foreground ",
        secondary:
          "ocp:bg-secondary ocp:text-secondary-foreground ocp:hover:bg-secondary/80",
        ghost:
          "ocp:hover:bg-accent ocp:hover:text-accent-foreground ",
        link: "ocp:text-primary ocp:underline-offset-4 ocp:hover:underline",
      },
      size: {
        "default": "ocp:h-9 ocp:px-4 ocp:py-2 ocp:has-[>svg]:px-3",
        "xs": "ocp:h-6 ocp:gap-1 ocp:rounded-md ocp:px-2 ocp:text-xs ocp:has-[>svg]:px-1.5 ocp:[&_svg:not([class*='size-'])]:size-3",
        "sm": "ocp:h-8 ocp:rounded-md ocp:gap-1.5 ocp:px-3 ocp:has-[>svg]:px-2.5",
        "lg": "ocp:h-10 ocp:rounded-md ocp:px-6 ocp:has-[>svg]:px-4",
        "icon": "ocp:size-9",
        "icon-xs": "ocp:size-6 ocp:rounded-md ocp:[&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "ocp:size-8",
        "icon-lg": "ocp:size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
