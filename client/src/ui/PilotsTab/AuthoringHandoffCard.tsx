import { Button } from "@/components/ui/button";

export function AuthoringHandoffCard({
  taskId,
  criterionCount,
  guidelineSha,
  onCurate,
}: {
  taskId: string;
  criterionCount: number;
  guidelineSha: string;
  onCurate: () => void;
}) {
  return (
    <div className="mx-auto my-8" style={{ maxWidth: 520 }}>
      <div
        className="rounded-lg border border-[hsl(var(--oxblood)/0.25)] bg-card px-8 py-9 text-center"
        style={{
          boxShadow:
            "0 1px 0 hsl(var(--oxblood) / 0.10), 0 12px 32px -16px hsl(var(--oxblood) / 0.18)",
        }}
      >
        <span
          className="seal mx-auto"
          style={{ width: "1.6rem", height: "1.6rem", fontSize: "0.85rem" }}
          aria-hidden
        >
          R
        </span>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mt-5">
          {taskId}
        </div>
        <div
          className="mt-2 font-display text-[24px] leading-tight"
          style={{ fontVariationSettings: '"opsz" 28, "SOFT" 50' }}
        >
          {criterionCount} criteria · sha{" "}
          <span className="font-mono text-[19px]">{guidelineSha.slice(0, 8)}</span>
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground max-w-[40ch] mx-auto">
          Pick 10 dev + 30 lock patients, stratified to cover at least one positive, one negative,
          and one edge case per primary criterion.
        </p>
        <Button onClick={onCurate} variant="default" size="default" className="mt-7">
          Curate cohorts →
        </Button>
      </div>
    </div>
  );
}
