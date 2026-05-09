import { ReactNode } from "react";

export interface AlertsSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function AlertsSheet({ open, onClose, children }: AlertsSheetProps) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-[420px] bg-white border-l border-slate-200 z-50 overflow-y-auto p-4 shadow-2xl">
        {children}
      </aside>
    </>
  );
}
