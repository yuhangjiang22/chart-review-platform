"""Pydantic models for the review pipeline.

Six record types share field definitions; keeping them in one module avoids
circular forward references and makes the schema easy to read end-to-end.
"""
from __future__ import annotations

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class MatchKind(str, Enum):
    # Value names use the convention `<status>_<detail>` so the status is
    # visible just by reading the match_kind string in raw JSONL. The mapping
    # to status is enforced by derive_status() below — keep them in sync.
    mapped_exact = "mapped_exact"
    mapped_case_normalized = "mapped_case_normalized"
    mapped_underscore_normalized = "mapped_underscore_normalized"
    mapped_uncertain_alternatives_pick = "mapped_uncertain_alternatives_pick"
    mapped_uncertain_parent_fallback = "mapped_uncertain_parent_fallback"
    mapped_uncertain_navigated = "mapped_uncertain_navigated"
    novel_candidate_none = "novel_candidate_none"


Status = Literal["mapped", "mapped_uncertain", "novel_candidate"]
TerminalStatus = Literal["mapped", "novel_candidate"]


def derive_status(mk: MatchKind) -> Status:
    """Map match_kind -> status. The single source of truth for the rule
    documented in spec §4.2."""
    if mk in (MatchKind.mapped_exact,
              MatchKind.mapped_case_normalized,
              MatchKind.mapped_underscore_normalized):
        return "mapped"
    if mk in (MatchKind.mapped_uncertain_alternatives_pick,
              MatchKind.mapped_uncertain_parent_fallback,
              MatchKind.mapped_uncertain_navigated):
        return "mapped_uncertain"
    return "novel_candidate"


class Span(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def _check_order(self):
        if self.end <= self.start:
            raise ValueError("end must be strictly greater than start")
        return self


VerdictKind = Literal[
    "confirm",
    "correct_concept",
    "correct_type",
    "correct_span",
    "reject_not_entity",
    "reject_duplicate",
    "concept_name_novel",     # reviewer flag: agent mapped to existing concept but this is actually a novel mention requiring ontology expansion. Proposal creation deferred to adjudicator/maintainer.
    "propose_split",
    "propose_merge",
]


class CorrectedFields(BaseModel):
    concept_name: Optional[str] = None
    entity_type: Optional[str] = None
    span: Optional[Span] = None


class OntologyProposalAttachment(BaseModel):
    action: Literal["add_new", "add_as_synonym_of"]
    suggested_name: str = ""
    suggested_parent: Optional[str] = None
    rationale: str = ""


class MentionRecord(BaseModel):
    """Agent's output for one mention. Stage 1 artifact."""
    mention_id: str
    note_id: str
    person_id: Optional[str] = None
    text: str
    anchor: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    entity_type: str
    concept_name: str
    status: Status
    match_kind: MatchKind
    model: str
    skill_version: str
    ontology_version: str

    @model_validator(mode="after")
    def _check_status_matches_match_kind(self):
        if derive_status(self.match_kind) != self.status:
            raise ValueError(
                f"status={self.status!r} inconsistent with match_kind={self.match_kind.value!r}; "
                f"expected {derive_status(self.match_kind)!r}"
            )
        return self


class ReviewerVerdict(BaseModel):
    """One reviewer's judgment on one mention. Stage 2 artifact."""
    mention_id: str
    reviewer_id: str
    verdict: VerdictKind
    corrected: Optional[CorrectedFields] = None
    ontology_proposal: Optional[OntologyProposalAttachment] = None
    notes: str = ""
    reviewed_at: str  # ISO-8601 UTC
    review_duration_ms: Optional[int] = Field(default=None, ge=0)
    superseded_at: Optional[str] = None  # set when an amend replaces this row

    @model_validator(mode="after")
    def _check_verdict_payload(self):
        c = self.corrected
        if self.verdict == "correct_concept":
            if c is None or c.concept_name is None:
                raise ValueError("verdict=correct_concept requires corrected.concept_name")
        elif self.verdict == "correct_type":
            if c is None or c.entity_type is None:
                raise ValueError("verdict=correct_type requires corrected.entity_type")
        elif self.verdict == "correct_span":
            if c is None or c.span is None:
                raise ValueError("verdict=correct_span requires corrected.span")
        return self


class ReviewerVerdictRef(BaseModel):
    """Slim copy embedded in adjudication / merged records."""
    reviewer_id: str
    verdict: VerdictKind
    corrected: Optional[CorrectedFields] = None
    notes: str = ""
    ontology_proposal: Optional[OntologyProposalAttachment] = None


DisagreementType = Literal[
    "concept", "type", "span", "existence",
    "boundary_split_merge", "ontology_proposal_only",
]


class AdjudicationFinal(BaseModel):
    verdict: VerdictKind
    concept_name: Optional[str] = None
    entity_type: Optional[str] = None
    span: Optional[Span] = None


class AdjudicationRecord(BaseModel):
    """Third-party resolution of a disagreement. Stage 4 artifact."""
    mention_id: str
    reviewer_verdicts: list[ReviewerVerdictRef]
    disagreement_type: DisagreementType
    adjudicator_id: str
    final: AdjudicationFinal
    rationale: str = ""
    decided_at: str
    deferred: bool = False
    superseded_at: Optional[str] = None  # set when the adjudicator clears + redecides


class AgreementDims(BaseModel):
    existence: bool
    span: Optional[bool] = None  # None when existence disagreed
    type: Optional[bool] = None
    concept: Optional[bool] = None


class MergedRecord(BaseModel):
    """One mention with both reviewers' verdicts joined. Stage 3 artifact."""
    mention_id: str
    agent: MentionRecord
    verdicts: list[ReviewerVerdictRef]
    agreement: AgreementDims
    needs_adjudication: bool
    disagreement_type: Optional[DisagreementType] = None


class GoldProvenance(BaseModel):
    agent_proposal_concept: str
    agent_match_kind: MatchKind
    review_path: Literal["unanimous", "adjudicated"]
    reviewers: list[str] = Field(default_factory=list)
    adjudicator_id: Optional[str] = None
    ontology_version: Optional[str] = None


class GoldRecord(BaseModel):
    """Stage 5 canonical mention. status is always terminal."""
    mention_id: str
    case_id: str
    pmid: str
    text: str
    anchor: str
    start: int
    end: int
    entity_type: str
    concept_name: str
    status: TerminalStatus
    provenance: GoldProvenance


class ReviewerProposalRef(BaseModel):
    reviewer_id: str
    suggested_name: str
    suggested_parent: Optional[str] = None
    rationale: str = ""


class OntologyProposal(BaseModel):
    """Stage 0 aggregated proposal. ready_for_review is the double-signal flag."""
    proposal_id: str
    surface_form: str
    normalized_form: str
    occurrence_count: int = Field(ge=0)
    case_ids: list[str]
    source_mention_ids: list[str] = Field(default_factory=list)
    reviewer_proposals: list[ReviewerProposalRef]
    frequency_threshold_met: bool
    reviewer_proposal_count: int = Field(ge=0)
    queued_at: str
    status: Literal["pending", "accepted", "rejected", "merged", "deferred"] = "pending"
    decision: Optional[dict] = None
    decided_by: Optional[str] = None
    decided_at: Optional[str] = None

    @property
    def ready_for_review(self) -> bool:
        return self.frequency_threshold_met and self.reviewer_proposal_count >= 1
