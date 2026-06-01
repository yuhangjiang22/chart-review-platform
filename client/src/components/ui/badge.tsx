// shadcn Badge — rich variant set tuned for the editorial palette.
// Confidence pills (low/medium/high), status (proposed / approved / locked /
// stale), reason tags (override-reason vocabulary).
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        ink: "border-transparent bg-ink text-paper",
        primary: "border-transparent bg-primary text-primary-foreground",
        // Editorial semantic — sage validated, ochre warning, oxblood lock.
        validated: "border-transparent bg-sage/15 text-sage-foreground text-[hsl(var(--sage))]",
        warning: "border-transparent bg-ochre/15 text-[hsl(var(--ochre))]",
        locked: "border-transparent bg-oxblood text-paper shadow-seal",
        // Confidence
        "conf-high": "border border-sage/30 bg-sage/10 text-[hsl(var(--sage))]",
        "conf-medium": "border border-ochre/30 bg-ochre/10 text-[hsl(var(--ochre))]",
        "conf-low": "border border-muted bg-muted text-muted-foreground",
        // Workflow status
        proposed: "border-border bg-card text-muted-foreground",
        approved: "border-transparent bg-sage/15 text-[hsl(var(--sage))]",
        overridden: "border-transparent bg-ochre/15 text-[hsl(var(--ochre))]",
        pending: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
