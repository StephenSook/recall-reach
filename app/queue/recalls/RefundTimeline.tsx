"use client";

import "@bryntum/core-community/fontawesome/css/fontawesome.css";
import "@bryntum/core-community/fontawesome/css/solid.css";
import "@bryntum/scheduler-community/scheduler.css";
import "@bryntum/scheduler-community/svalbard.css";
import { BryntumScheduler } from "@bryntum/scheduler-react-community";
import { useEffect, useState } from "react";
import type { Timeline, TimelineSale } from "./timeline";

const ROW_HEIGHT = 64;
const HEADER_HEIGHT = 64;
const DATES_ROW = "dates";
// The app's own state colors, so a sale reads the same here as on its card.
const COLOR: Record<TimelineSale["tone"], string> = {
  notice: "#606060",
  check: "#ffd31e",
  refund: "#d00416",
};

const localDay = (day: string) => new Date(`${day}T00:00:00`);

function dateLine(kind: "recall" | "today", label: string, day: string): HTMLElement {
  const line = document.createElement("div");
  line.className = `timeline-line timeline-line-${kind}`;
  line.dataset.testid = `line-${kind}`;
  const text = document.createElement("span");
  text.textContent = `${label}\n${day}`;
  line.append(text);
  return line;
}

export default function RefundTimeline({ timeline }: { timeline: Timeline }) {
  const [scheduler, setScheduler] = useState<BryntumScheduler | null>(null);
  const { recallDate, today } = timeline;

  // Lines down the whole chart for the recall date and today. The free tier has no time ranges. These are added by hand
  // rather than by React, because the chart's own element goes when the chart does.
  useEffect(() => {
    const instance = scheduler?.instance;
    const chart = instance?.timeAxisSubGridElement;
    if (!instance || !chart) return;
    const lines: [HTMLElement, string][] = [
      [dateLine("recall", "Recall", recallDate), recallDate],
      [dateLine("today", "Today", today), today],
    ];
    const place = () => {
      for (const [line, day] of lines) line.style.left = `${instance.getCoordinateFromDate(localDay(day), true)}px`;
    };
    chart.append(...lines.map(([line]) => line));
    place();
    instance.on("timelineViewportResize", place);
    return () => {
      // Leaving the page takes the chart first, and a destroyed chart has no methods left to call.
      if (instance.isDestroyed) return;
      instance.un("timelineViewportResize", place);
      for (const [line] of lines) line.remove();
    };
  }, [scheduler, recallDate, today]);

  const resources = [{ id: DATES_ROW, name: "Dates" }, ...timeline.sales.map((s) => ({ id: s.id, name: s.title }))];
  const events = timeline.sales.map((s) => ({
    id: `sale-${s.id}`,
    resourceId: s.id,
    name: s.meaning,
    startDate: localDay(s.orderedOn),
    endDate: localDay(s.windowEnds),
    eventColor: COLOR[s.tone],
    cls: `timeline-${s.tone}`,
  }));
  return (
    <div className="refund-timeline" data-testid="refund-timeline" style={{ height: HEADER_HEIGHT + resources.length * ROW_HEIGHT + 2 }}>
      <BryntumScheduler
        ref={setScheduler}
        readOnly
        startDate={localDay(timeline.from)}
        endDate={localDay(timeline.to)}
        viewPreset="monthAndYear"
        forceFit={timeline.fits}
        rowHeight={ROW_HEIGHT}
        barMargin={10}
        columns={[{ text: "Sale", field: "name", width: 320, editor: false, sortable: false }]}
        resources={resources}
        events={events}
        eventStyle="filled"
        cellEditFeature={false}
        eventDragFeature={false}
        eventDragCreateFeature={false}
        eventEditFeature={false}
        eventMenuFeature={false}
        eventResizeFeature={false}
        scheduleMenuFeature={false}
      />
    </div>
  );
}
