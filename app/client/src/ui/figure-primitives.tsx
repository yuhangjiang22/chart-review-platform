// Shared figure-page primitives used by Studio.tsx and PilotsTab/index.tsx.
// Moved here from Studio.tsx so both files can import without circular deps.
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

export function FigurePage({
  caption,
  title,
  lede,
  children,
}: {
  caption: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="animate-fade-in">
      <div className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">{caption}</div>
      <h2
        className="mt-1.5 font-display text-[26px] leading-tight tracking-tight"
        style={{ fontVariationSettings: '"opsz" 30, "SOFT" 50' }}
      >
        {title}
      </h2>
      {lede && (
        <p className="mt-2 max-w-[68ch] text-[13.5px] leading-relaxed text-muted-foreground">{lede}</p>
      )}
      <div className={lede ? "mt-7" : "mt-5"}>{children}</div>
    </article>
  );
}

export function FigureStats({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-12 gap-y-3 md:grid-cols-3">
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  accent = false,
  mute = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  mute?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-[34px] leading-none tabular-nums",
          accent && "text-[hsl(var(--oxblood))]",
          mute && "text-muted-foreground",
        )}
        style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
      >
        {value}
      </div>
    </div>
  );
}

export function EmptyHint({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof FlaskConical;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-paper/40 p-8 text-[13px]">
      <Icon size={20} className="text-muted-foreground/60" strokeWidth={1.25} />
      <div className="font-display text-[16px]">{title}</div>
      <div className="max-w-[60ch] text-muted-foreground">{body}</div>
    </div>
  );
}
