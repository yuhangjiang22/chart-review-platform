// TaskKindRegistry — consolidates the per-task-kind UI pieces so the
// rest of Workspace.tsx + App.tsx looks up "the AUTHOR pane for this
// kind" / "the reviewer pane for this kind" / "the unit-noun for this
// kind" in one place instead of branching on task_kind at every consumer.
//
// Platform v2 light: only phenotype is supported.

import type { ComponentType } from "react";
import type { CompiledField, NoteFocus, ReviewState } from "../../types";

import { PhaseDraft } from "./PhaseDraft";
import { PatientReview } from "../PatientReview";

export type TaskKind = "phenotype";

/** Props shared by every AUTHOR pane. */
export interface AuthorPaneCommonProps {
  taskId: string;
}

export type AuthorPaneComponent = ComponentType<{
  taskId: string;
  onPreflightHasErrors?: (b: boolean) => void;
}>;

/** Reviewer-page props mirrored from PatientReview. */
export interface ReviewerPaneCommonProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
}

export type ReviewerPaneComponent = ComponentType<{
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
  fields?: CompiledField[];
  reviewState?: ReviewState | null;
  onStateChanged?: (state: ReviewState) => void;
  noteFocus?: NoteFocus | null;
  onJumpToSource?: (focus: NoteFocus | null) => void;
  criterionId?: string | null;
  onCriterionChange?: (id: string | null, opts?: { replace?: boolean }) => void;
}>;

export interface TaskKindUiBundle {
  kind: TaskKind;
  authorPane: AuthorPaneComponent;
  reviewerPane: ReviewerPaneComponent;
  unitLabel: { singular: string; plural: string };
}

const REGISTRY: Record<TaskKind, TaskKindUiBundle> = {
  phenotype: {
    kind: "phenotype",
    authorPane: PhaseDraft as AuthorPaneComponent,
    reviewerPane: PatientReview as ReviewerPaneComponent,
    unitLabel: { singular: "cell", plural: "cells" },
  },
};

/**
 * Resolve a task-kind to its UI bundle. Unknown values default to
 * phenotype, which is the safe fallback for legacy tasks.
 */
export function taskKindUi(_rawTaskType: string | undefined): TaskKindUiBundle {
  return REGISTRY.phenotype;
}

/** Normalize the raw meta.yaml `task_type` to a TaskKind discriminator.
 *  Mirrors the server-side `taskKindFromTaskType`. */
export function taskKindFromTaskType(_rawTaskType: string | undefined): TaskKind {
  return "phenotype";
}
