"use client";

import { useState } from "react";
import { PATH_CHIP, chipClass } from "../queue/labels";
import { dayBefore, whatIfPaths } from "./whatIfRule";

/** The demo's bedside sleeper, sold after its recall, beside the same sale on a date the judge picks. Nothing is saved. */
export function WhatIf({ soldOn, recallDate }: { soldOn: string; recallDate: string }) {
  const [movedTo, setMovedTo] = useState(dayBefore(recallDate));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(movedTo);
  const { original, moved } = whatIfPaths(soldOn, valid ? movedTo : soldOn, recallDate);
  return (
    <div className="what-if" data-testid="what-if">
      <p>
        As sold, {soldOn}: <span className={chipClass(PATH_CHIP[original])}>{PATH_CHIP[original]}</span>
      </p>
      <p>
        <label>
          What if it sold on <input type="date" value={movedTo} onChange={(e) => setMovedTo(e.target.value)} />
        </label>
        : <span className={chipClass(PATH_CHIP[moved])} aria-live="polite">{PATH_CHIP[moved]}</span>
      </p>
    </div>
  );
}
