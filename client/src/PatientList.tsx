import { useState, useEffect } from "react";
import type { PatientSummary } from "./types";
import { readAuth } from "./auth";

interface Props {
  patients: PatientSummary[];
  selectedId: string | null;
  onSelect: (patientId: string) => void;
}

export function PatientList({ patients, selectedId, onSelect }: Props) {
  const [filter, setFilter] = useState<"mine" | "all">(() =>
    (localStorage.getItem("chartReview.queueFilter") as "mine" | "all") ?? "mine"
  );

  useEffect(() => {
    localStorage.setItem("chartReview.queueFilter", filter);
  }, [filter]);

  const myReviewerId = readAuth().reviewer_id;

  const filteredPatients =
    filter === "mine" && myReviewerId
      ? patients.filter((p) => {
          // Patients with no assigned_to OR assigned_to includes me are visible
          const a = (p as { assigned_to?: string[] }).assigned_to;
          return !a || a.length === 0 || a.includes(myReviewerId);
        })
      : patients;

  return (
    <aside className="w-64 border-r border-border bg-card overflow-y-auto">
      <div className="p-3 border-b border-border">
        <h2 className="font-semibold text-foreground text-sm uppercase tracking-wide">
          Patients
        </h2>
      </div>
      <div className="flex items-center gap-1 px-2 py-1 text-[11px]">
        <button
          onClick={() => setFilter("mine")}
          className={`px-2 py-0.5 rounded ${
            filter === "mine"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          mine
        </button>
        <button
          onClick={() => setFilter("all")}
          className={`px-2 py-0.5 rounded ${
            filter === "all"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          all
        </button>
        <span className="text-muted-foreground/70 ml-2">
          {filteredPatients.length}/{patients.length}
        </span>
      </div>
      <ul>
        {filteredPatients.map((p) => {
          const selected = p.patient_id === selectedId;
          return (
            <li key={p.patient_id}>
              <button
                onClick={() => onSelect(p.patient_id)}
                className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-muted/50 ${
                  selected ? "bg-secondary border-l-4 border-l-blue-500" : ""
                }`}
              >
                <div className="font-medium text-foreground text-sm">
                  {p.display_name ?? p.patient_id}
                </div>
                <div className="flex gap-1 mt-1">
                  {p.category && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {p.category.replace(/_/g, " ")}
                    </span>
                  )}
                  {p.difficulty && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        p.difficulty === "hard"
                          ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]"
                          : "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
                      }`}
                    >
                      {p.difficulty}
                    </span>
                  )}
                  {p.review_status && p.review_status !== "draft" && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        p.review_status === "locked"
                          ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
                          : p.review_status === "reviewer_validated"
                            ? "bg-violet-100 text-violet-700"
                            : "bg-muted text-muted-foreground"
                      }`}
                      title={`review status: ${p.review_status}`}
                    >
                      {p.review_status.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                {p.headline ? (
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {p.headline}
                  </div>
                ) : null}
                <div className="text-[11px] text-muted-foreground/70 mt-1">
                  {[p.age && `${p.age}y`, p.sex, p.index_date]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </button>
            </li>
          );
        })}
        {filteredPatients.length === 0 && (
          <li className="p-3 text-xs text-muted-foreground/70">No patients found.</li>
        )}
      </ul>
    </aside>
  );
}
