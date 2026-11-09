import type { StudioRow } from "@/server/studio/dataset";

const OUTCOME_COLOURS: Record<StudioRow["outcome"], string> = {
  Matched: "#e8590c",
  "Can't tell yet": "#fcc419",
  Cleared: "#69db7c",
  "Nothing near": "#ced4da",
};

const isOutcome = (value: string): value is StudioRow["outcome"] => Object.prototype.hasOwnProperty.call(OUTCOME_COLOURS, value);

/** One outcome as a coloured chip. Text that isn't one of the four outcomes shows as it is. */
export function OutcomeBadge({ outcome }: { outcome: string }) {
  if (!isOutcome(outcome)) return <>{outcome}</>;
  return (
    <span
      style={{
        display: "inline-block",
        // Small enough that "Nothing near" fits the grid's default column width.
        padding: "0 7px",
        borderRadius: 999,
        lineHeight: "20px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
        // Black text clears 4.5:1 on all four backgrounds (lowest: 5.87:1 on #e8590c).
        color: "#000000",
        background: OUTCOME_COLOURS[outcome],
      }}
    >
      {outcome}
    </span>
  );
}
