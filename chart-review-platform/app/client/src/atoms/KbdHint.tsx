export interface KbdHintProps {
  keys: string[];
}

export function KbdHint({ keys }: KbdHintProps) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10.5px] font-mono text-slate-700"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
