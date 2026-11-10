"use client";

import { useState } from "react";
import { PATH_CHIP, chipClass } from "../queue/labels";
import { dayBefore, whatIfPaths } from "./whatIfRule";

/**
 * Two hypothetical sales of the bedside sleeper: one today, one on a date the judge picks. Only the date rule is shown, not the
 * demo sale's own state (it may already be refunded). Nothing is saved.
 */
export function WhatIf({ soldOn, recallDate }: { soldOn: string; recallDate: string }) {
  const [movedTo, setMovedTo] = useState(dayBefore(recallDate));
  const { original, moved } = whatIfPaths(soldOn, movedTo, recallDate);
  return (
    <div className="what-if" data-testid="what-if">
      <p>
        If it sold today, {soldOn}: <span className={chipClass(PATH_CHIP[original])}>{PATH_CHIP[original]}</span>
      </p>
      <p>
        <label>
          If it sold on <input type="date" value={movedTo} max={soldOn} onChange={(e) => setMovedTo(e.target.value)} />
        </label>
        :{" "}
        <span aria-live="polite">{moved ? <span className={chipClass(PATH_CHIP[moved])}>{PATH_CHIP[moved]}</span> : "Pick a date"}</span>
      </p>
    </div>
  );
}
