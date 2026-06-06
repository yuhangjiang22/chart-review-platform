import { ReactNode } from "react";

// Badge — re-themed against the editorial palette. Same variant names so
// existing call sites keep working.
export type BadgeVariant =
  | "secondary"
  | "outline"
  | "ok"
  | "warn"
  | "err"
  | "mono"
  | "primary"
  | "ghost";

export type BadgeSize = "xs" | "sm" | "md";

export interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
  className?: string;
  [key: string]: unknown;
}

const VARIANTS: Record<BadgeVariant, string> = {
  secondary: "bg-secondary text-foreground border-transparent",
  outline: "bg-transparent text-foreground border-border",
  ok: "bg-[hsl(var(--sage)/0.12)] text-[hsl(var(--sage))] border-[hsl(var(--sage)/0.25)]",
  warn: "bg-[hsl(var(--ochre)/0.12)] text-[hsl(var(--ochre))] border-[hsl(var(--ochre)/0.25)]",
  err: "bg-[hsl(var(--oxblood)/0.10)] text-[hsl(var(--oxblood))] border-[hsl(var(--oxblood)/0.25)]",
  mono: "bg-muted text-foreground border-border font-mono",
  primary: "bg-primary text-primary-foreground border-transparent",
  ghost: "bg-transparent text-muted-foreground border-transparent",
};

const SIZES: Record<BadgeSize, string> = {
  xs: "text-[10.5px] px-1.5 py-[1px]",
  sm: "text-[11px] px-2 py-0.5",
  md: "text-[12px] px-2.5 py-0.5",
};

export function Badge({
  variant = "secondary",
  size = "sm",
  children,
  className = "",
  ...rest
}: BadgeProps) {
  const variantCls = VARIANTS[variant] ?? VARIANTS.secondary;
  return (
    <span
      {...rest}
      className={`inline-flex items-center gap-1 rounded-md border ${variantCls} ${SIZES[size]} ${className}`}
    >
      {children}
    </span>
  );
}
