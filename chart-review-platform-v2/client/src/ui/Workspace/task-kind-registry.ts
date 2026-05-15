// TaskKindRegistry — consolidates the per-task-kind UI pieces so the
// rest of Workspace.tsx + App.tsx looks up "the AUTHOR pane for this
// kind" / "the reviewer pane for this kind" / "the unit-noun for this
// kind" in one place instead of branching `task_kind === "ner" ? X : Y`
// at every consumer.
//
// Adding a third task_kind (event extraction, relation extraction, etc.)
// becomes "add one entry here" rather than a sweep across every phase
// pane and the App router. Phenotype + NER ship today; future kinds
// register through the same shape.
//
// Scope (Phase 4.7 minimal):
//   - authorPane: AUTHOR-phase component
//   - reviewerPane: patient-page reviewer component
//   - unitLabel.{singular, plural}: terminology used by progress headlines + counters
//
// Things deliberately NOT in this registry yet:
//   - judge / decide / lock / deploy pane variants. They currently branch
//     internally on a `taskKind` prop, which is small enough to leave
//     in-component until a third kind makes the duplication painful.
//   - status-deriving logic for the queue. That's server-side and
//     task-kind-aware via the patients endpoint.

import type { ComponentType } from "react";
import type { CompiledField, NoteFocus, ReviewState } from "../../types";

import { PhaseDraft } from "./PhaseDraft";
import { PhaseSpanAuthor } from "./PhaseSpanAuthor";
import { PatientReview } from "../PatientReview";
import { SpanReview } from "../SpanReview";

export type TaskKind = "phenotype" | "ner";

/** Props shared by every AUTHOR pane. Each pane takes a superset of
 *  these — the registry just enforces the common surface. */
export interface AuthorPaneCommonProps {
  taskId: string;
}

/** Phenotype AUTHOR pane (PhaseDraft) signature, captured loosely so
 *  the registry value type-checks. PhaseDraft has an extra
 *  `onPreflightHasErrors` callback that NER's PhaseSpanAuthor doesn't
 *  need; we wrap each in an adapter below. */
export type AuthorPaneComponent = ComponentType<{
  taskId: string;
  // phenotype-only:
  onPreflightHasErrors?: (b: boolean) => void;
  // NER-only:
  canEdit?: boolean;
}>;

/** Reviewer-page props mirrored from PatientReview / SpanReview. */
export interface ReviewerPaneCommonProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
}

/** Both reviewer panes accept all of the common props + their own
 *  task-kind-specific extras. The mounting code in App.tsx passes the
 *  phenotype-shaped extras unconditionally; SpanReview ignores the
 *  ones it doesn't need (and PatientReview ignores any NER-only ones
 *  we add later). */
export type ReviewerPaneComponent = ComponentType<{
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
  // phenotype-only:
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
  ner: {
    kind: "ner",
    authorPane: PhaseSpanAuthor as AuthorPaneComponent,
    reviewerPane: SpanReview as ReviewerPaneComponent,
    unitLabel: { singular: "span", plural: "spans" },
  },
};

/**
 * Resolve a task-kind to its UI bundle. Accepts the raw meta.yaml
 * `task_type` (e.g. "phenotype_validation", "ner") so callers don't
 * need to normalize first; unknown values default to phenotype, which
 * is the safe fallback for legacy tasks.
 */
export function taskKindUi(rawTaskType: string | undefined): TaskKindUiBundle {
  return rawTaskType === "ner" ? REGISTRY.ner : REGISTRY.phenotype;
}
