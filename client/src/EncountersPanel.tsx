// #45 — compact panel for managing the encounter / episode list on a
// review_state. Renders the existing encounters with a small × delete
// button, and an inline "Add encounter" form. State updates flow back
// through the WebSocket review_state_update broadcast — we don't keep a
// local copy of the list.

import { useState } from "react";
import type { ReviewState } from "./types";
import { authFetch } from "./auth";
import { withSession } from "./active-session";

export interface EncountersPanelProps {
  patientId: string;
  taskId: string;
  reviewState: ReviewState | null;
}

export function EncountersPanel({
  patientId,
  taskId,
  reviewState,
}: EncountersPanelProps) {
  const encounters = reviewState?.encounters ?? [];

  const [kind, setKind] = useState<"encounter" | "episode">("encounter");
  const [date, setDate] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [noteIdsRaw, setNoteIdsRaw] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addEncounter() {
    setBusy(true);
    setError(null);
    try {
      const note_ids = noteIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const body: Record<string, unknown> = { kind };
      if (date) body.date = date;
      if (label) body.label = label;
      if (note_ids.length > 0) body.note_ids = note_ids;

      const r = await authFetch(
        withSession(`/api/reviews/${patientId}/${taskId}/encounters`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setError(j.message ?? `add failed (${r.status})`);
        return;
      }
      // Reset form on success.
      setDate("");
      setLabel("");
      setNoteIdsRaw("");
      // kind stays — most reviewers add a series of the same kind in a row.
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeEncounter(encounterId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(
        withSession(`/api/reviews/${patientId}/${taskId}/encounters/${encounterId}`),
        { method: "DELETE" },
      );
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setError(j.message ?? `delete failed (${r.status})`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-[12.5px] text-foreground space-y-3">
      <div>
        <div className="text-[12px] font-semibold text-foreground mb-1">
          Encounters &amp; episodes ({encounters.length})
        </div>
        {encounters.length === 0 ? (
          <div className="text-[11.5px] italic text-muted-foreground">
            No encounters yet. Add one below — useful when the guideline
            captures findings per visit (oncology workup, recurrent
            infections, …).
          </div>
        ) : (
          <ul className="divide-y divide-border border border-border rounded">
            {encounters.map((e) => (
              <li
                key={e.encounter_id}
                className="px-2 py-1.5 flex items-center gap-2"
              >
                <code
                  className="font-mono text-[10.5px] text-muted-foreground"
                  title={e.encounter_id}
                >
                  {e.encounter_id.slice(0, 8)}
                </code>
                <span
                  className={
                    "px-1.5 py-0.5 rounded text-[10.5px] " +
                    (e.kind === "episode"
                      ? "bg-purple-50 text-purple-700"
                      : "bg-sky-50 text-sky-700")
                  }
                >
                  {e.kind}
                </span>
                {e.date && (
                  <span className="text-muted-foreground num-tabular">{e.date}</span>
                )}
                {e.label && (
                  <span className="text-foreground truncate flex-1">
                    {e.label}
                  </span>
                )}
                {(!e.label) && <span className="flex-1" />}
                {e.note_ids && e.note_ids.length > 0 && (
                  <span className="text-[10.5px] text-muted-foreground">
                    {e.note_ids.length} note{e.note_ids.length === 1 ? "" : "s"}
                  </span>
                )}
                <button
                  onClick={() => removeEncounter(e.encounter_id)}
                  disabled={busy}
                  className="text-muted-foreground/70 hover:text-[hsl(var(--oxblood))] disabled:opacity-50 px-1"
                  title="Remove encounter"
                  aria-label={`Remove encounter ${e.encounter_id}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border pt-3 space-y-2">
        <div className="text-[12px] font-semibold text-foreground">
          Add encounter
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            <span className="text-[11.5px] text-muted-foreground">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "encounter" | "episode")}
              className="text-[12px] px-1.5 py-1 rounded border border-border"
            >
              <option value="encounter">encounter</option>
              <option value="episode">episode</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-[11.5px] text-muted-foreground">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="text-[12px] px-1.5 py-1 rounded border border-border"
            />
          </label>
          <label className="flex items-center gap-1 flex-1 min-w-[12rem]">
            <span className="text-[11.5px] text-muted-foreground">Label</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. oncology consult 2024-08-22"
              className="text-[12px] px-1.5 py-1 rounded border border-border flex-1"
            />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 flex-1">
            <span className="text-[11.5px] text-muted-foreground">
              Note ids (comma-separated, optional)
            </span>
            <input
              type="text"
              value={noteIdsRaw}
              onChange={(e) => setNoteIdsRaw(e.target.value)}
              placeholder="note_001, note_002"
              className="text-[12px] px-1.5 py-1 rounded border border-border flex-1 font-mono"
            />
          </label>
          <button
            onClick={addEncounter}
            disabled={busy}
            className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white disabled:opacity-50 hover:bg-[hsl(var(--sage)/0.85)] text-[12px]"
          >
            Add
          </button>
        </div>
        {error && (
          <div className="text-[11.5px] text-[hsl(var(--oxblood))]">error: {error}</div>
        )}
      </div>
    </div>
  );
}
