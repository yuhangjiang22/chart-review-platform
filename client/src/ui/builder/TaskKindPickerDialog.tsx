// TaskKindPickerDialog — step 1 of the "Create new task" flow.
//
// Platform v2 light: only phenotype tasks are supported.
// This dialog immediately forwards to the phenotype authoring flow.

import { useEffect } from "react";

export type TaskKindChoice = "phenotype";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with "phenotype" — caller opens the existing
   *  AuthoringModeDialog. */
  onPickPhenotype: () => void;
  /** Kept for API compatibility — never called in phenotype-only mode. */
  onScaffolded?: (taskId: string, kind: never) => void;
}

export function TaskKindPickerDialog({
  open, onClose, onPickPhenotype,
}: Props) {
  // Immediately forward to phenotype flow when opened.
  useEffect(() => {
    if (open) {
      onClose();
      onPickPhenotype();
    }
  }, [open, onClose, onPickPhenotype]);

  return null;
}
