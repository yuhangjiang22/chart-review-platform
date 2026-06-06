import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onPickBuilder: () => void;
  onPickOneShot: () => void;
}

export function AuthoringModeDialog({ open, onClose, onPickBuilder, onPickOneShot }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose authoring mode</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-3">
          <button
            onClick={onPickBuilder}
            className="block w-full rounded-md border border-oxblood/30 bg-oxblood/5 p-3 text-left hover:bg-oxblood/10"
          >
            <div className="font-serif text-base">Builder (interactive)</div>
            <div className="text-xs text-muted-foreground mt-1">
              Conversational flow. The agent asks one micro-question per turn,
              you accept or override, fragments accumulate live, you consolidate
              when ready. Best when you don't have a complete spec yet.
            </div>
          </button>
          <button
            onClick={onPickOneShot}
            className="block w-full rounded-md border border-border bg-card p-3 text-left hover:bg-muted"
          >
            <div className="font-serif text-base">One-shot (fast path)</div>
            <div className="text-xs text-muted-foreground mt-1">
              Provide objective + references; agent drafts the whole package in
              one run. Best when you already know what you want.
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
