import type { StudioRow } from "@/server/studio/dataset";

/** What the dashboard says when no shop item came near a recall. AG Studio would show "(Blanks)". */
export const NONE_NEAR = "None came near";

export const toStudioRows = (rows: ReadonlyArray<StudioRow>): StudioRow[] => rows.map((r) => (r.itemTitle === null ? { ...r, itemTitle: NONE_NEAR } : r));
