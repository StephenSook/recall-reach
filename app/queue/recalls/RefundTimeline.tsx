"use client";

import "@bryntum/core-community/fontawesome/css/fontawesome.css";
import "@bryntum/core-community/fontawesome/css/solid.css";
import "@bryntum/scheduler-community/scheduler.css";
import "@bryntum/scheduler-community/svalbard.css";
import { BryntumScheduler } from "@bryntum/scheduler-react-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { checkFollowUpDate, dayLabel, followUpLines, type FollowUpView } from "./followUps";
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
const dayAfter = (day: string) => new Date(localDay(day).getTime() + 86_400_000);
const dayOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const FOLLOW_PREFIX = "follow-";
// Outside the component, and memoized below: the chart re-reads any prop that's a new object, and that clears its bars.
const TIME_RESOLUTION = { unit: "day", increment: 1 } as const;
const COLUMNS = [{ text: "Sale", field: "name", width: 320, editor: false, sortable: false }];

function dateLine(kind: "recall" | "today", label: string, day: string): HTMLElement {
  const line = document.createElement("div");
  line.className = `timeline-line timeline-line-${kind}`;
  line.dataset.testid = `line-${kind}`;
  const text = document.createElement("span");
  text.textContent = `${label}\n${day}`;
  line.append(text);
  return line;
}

export default function RefundTimeline({ timeline, followUps = [], onMove }: { timeline: Timeline; followUps?: FollowUpView[]; onMove?: (saleId: string, due: string) => void }) {
  const [scheduler, setScheduler] = useState<BryntumScheduler | null>(null);
  const { recallDate, today } = timeline;
  // The chart's features are set up once, so they read the current follow-ups through this.
  const wrapper = useRef<HTMLDivElement | null>(null);
  const current = useRef({ followUps, timeline, onMove });
  useEffect(() => {
    current.current = { followUps, timeline, onMove };
  });

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

  const resources = useMemo(() => [{ id: DATES_ROW, name: "Dates" }, ...timeline.sales.map((s) => ({ id: s.id, name: s.title }))], [timeline.sales]);
  // Only the sales go in as a prop. Replacing the whole set after the first draw leaves the bars faded out, so follow-ups are
  // added to the chart's own store below.
  const events = useMemo(
    () =>
      timeline.sales.map((s) => ({
        id: `sale-${s.id}`,
        resourceId: s.id,
        name: s.meaning,
        startDate: localDay(s.orderedOn),
        endDate: localDay(s.windowEnds),
        eventColor: COLOR[s.tone],
        cls: `timeline-${s.tone}`,
        draggable: false,
        resizable: false,
      })),
    [timeline.sales],
  );
  useEffect(() => {
    const store = scheduler?.instance?.eventStore;
    if (!store) return;
    const wanted = new Map(
      followUps.map((f) => [
        `${FOLLOW_PREFIX}${f.saleId}`,
        { resourceId: f.saleId, name: `Follow up ${dayLabel(f.due)}`, startDate: localDay(f.due), endDate: dayAfter(f.due), cls: `timeline-follow timeline-follow-${f.state}`, draggable: f.state === "confirmed", resizable: false },
      ]),
    );
    for (const record of [...store.records]) {
      if (String(record.id).startsWith(FOLLOW_PREFIX) && !wanted.has(String(record.id))) store.remove(record);
    }
    for (const [id, data] of wanted) {
      const existing = store.getById(id);
      if (existing) existing.set(data);
      else store.add({ id, ...data });
    }
  }, [scheduler, followUps]);
  const anyConfirmed = followUps.some((f) => f.state === "confirmed");
  const hasFollowUps = followUps.length > 0;
  // The chart is hidden from screen readers, so it mustn't take keyboard focus either. The chart adds these stops as it redraws.
  useEffect(() => {
    const box = wrapper.current;
    if (!box || !hasFollowUps) return;
    const noStops = () => box.querySelectorAll('[tabindex="0"]').forEach((el) => el.setAttribute("tabindex", "-1"));
    noStops();
    const watch = new MutationObserver(noStops);
    watch.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ["tabindex"] });
    return () => watch.disconnect();
  }, [hasFollowUps]);
  const { dragFeature, tooltipFeature, onDrop } = useMemo(() => {
    const inFollowUp = (id: unknown) => current.current.followUps.find((f) => `${FOLLOW_PREFIX}${f.saleId}` === String(id));
    return {
      dragFeature: {
        constrainDragToResource: true,
        // The date shows in the list as soon as it's dropped, and this tip's own colors don't clear contrast.
        showTooltip: false,
        validatorFn: ({ eventRecords, startDate }: { eventRecords: { id: unknown }[]; startDate: Date }) => {
          const follow = inFollowUp(eventRecords[0]?.id);
          const sale = current.current.timeline.sales.find((s) => s.id === follow?.saleId);
          return Boolean(follow && sale) && checkFollowUpDate(sale as TimelineSale, dayOf(startDate), current.current.timeline.today) === "OK";
        },
      },
      tooltipFeature: {
        template: ({ eventRecord }: { eventRecord: { id: unknown; name: string } }) => {
          const follow = inFollowUp(eventRecord.id);
          // As text, never HTML: these words are Claude's and CPSC's.
          const lines = follow ? [eventRecord.name, ...followUpLines(follow)] : [eventRecord.name];
          return { tag: "div", children: lines.map((text) => ({ tag: "div", text })) };
        },
      },
      onDrop: ({ eventRecords }: { eventRecords: { id: unknown; startDate: unknown }[] }) => {
        const follow = inFollowUp(eventRecords[0]?.id);
        const start = eventRecords[0]?.startDate;
        if (follow && start instanceof Date) current.current.onMove?.(follow.saleId, dayOf(start));
      },
    };
  }, []);
  return (
    // Read-only until there's a follow-up to hover or drag. The list under it says the same in words and has every action, so
    // that's what a screen reader or keyboard gets: Bryntum's own markup puts buttons inside a grid role, so the chart stays hidden from them.
    <div ref={wrapper} className="refund-timeline" data-testid="refund-timeline" inert={!hasFollowUps} aria-hidden={hasFollowUps ? true : undefined} style={{ height: HEADER_HEIGHT + resources.length * ROW_HEIGHT + 2 }}>
      <BryntumScheduler
        ref={setScheduler}
        readOnly={!anyConfirmed}
        eventLayout="pack"
        timeResolution={TIME_RESOLUTION}
        startDate={localDay(timeline.from)}
        endDate={localDay(timeline.to)}
        viewPreset="monthAndYear"
        forceFit={timeline.fits}
        rowHeight={ROW_HEIGHT}
        barMargin={6}
        columns={COLUMNS}
        resources={resources}
        events={events}
        eventStyle="filled"
        cellEditFeature={false}
        eventDragFeature={dragFeature}
        onEventDrop={onDrop}
        eventTooltipFeature={tooltipFeature}
        eventEditFeature={false}
        eventMenuFeature={false}
        eventResizeFeature={false}
        scheduleMenuFeature={false}
      />
    </div>
  );
}
