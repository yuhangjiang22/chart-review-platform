import { Pill } from "./Pill";

export type Confidence = "low" | "medium" | "high";

const TONE: Record<Confidence, "ok" | "warn" | "err"> = {
  high: "ok",
  medium: "warn",
  low: "err",
};

export interface ConfidenceBadgeProps {
  value?: Confidence;
}

export function ConfidenceBadge({ value }: ConfidenceBadgeProps) {
  if (!value) return null;
  return <Pill tone={TONE[value]} title={`Confidence: ${value}`}>{value}</Pill>;
}
