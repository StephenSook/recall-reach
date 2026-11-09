"use client";

// The refund-window chart and the follow-ups on it. Claude proposes, the owner confirms, and every date is checked again on the
// server. Everything the chart can do, the list under it can do too, so a phone or a keyboard loses nothing.
import { useMemo, useState } from "react";
import type { SavedFollowUp } from "@/server/queue/followUps";
import { closingSoonLine, dayLabel, followUpLines, type FollowUpView, latestDay, type ProposedFollowUp } from "./followUps";
import { RefundTimelineLoader } from "./RefundTimelineLoader";
import type { Timeline } from "./timeline";

interface Plan {
  reason: string;
  hazardQuote: string;
  proposals: ProposedFollowUp[];
  closingSoon: number;
}

const toView = (s: SavedFollowUp): FollowUpView => ({ saleId: s.matchId, due: s.due, state: "confirmed", reason: s.reason, hazardQuote: s.hazardQuote, movedEarlier: s.movedEarlier });
const DIDNT_WORK = "That didn't work. Please try again.";

async function call(url: string, method: string, body?: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, data: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
  } catch {
    return { ok: false, data: {} };
  }
}

export function RefundWindows({ timeline, saved }: { timeline: Timeline; saved: SavedFollowUp[] }) {
  const [confirmed, setConfirmed] = useState<FollowUpView[]>(() => saved.map(toView));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const url = `/api/queue/recalls/${encodeURIComponent(timeline.recallNumber)}/follow-ups`;
  const titleOf = (saleId: string) => timeline.sales.find((s) => s.id === saleId)?.title ?? "This sale";
  const saleOf = (saleId: string) => timeline.sales.find((s) => s.id === saleId);

  const proposed = useMemo<FollowUpView[]>(() => (plan ? plan.proposals.map((p) => ({ saleId: p.saleId, due: p.due, state: "proposed", reason: plan.reason, hazardQuote: plan.hazardQuote, movedEarlier: p.movedEarlier })) : []), [plan]);
  const onChart = useMemo(() => [...confirmed, ...proposed], [confirmed, proposed]);
  const anyToPlan = timeline.sales.some((s) => s.needsReaching && !confirmed.some((c) => c.saleId === s.id));
  if (!anyToPlan && confirmed.length === 0) return <RefundTimelineLoader timeline={timeline} />;

  const propose = async () => {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await call(url, "POST");
    setBusy(false);
    if (!ok) return setMessage(typeof data.error === "string" ? data.error : DIDNT_WORK);
    const next = data as unknown as Plan;
    setPlan(next);
    if (next.proposals.length === 0 && next.closingSoon === 0) setMessage("No sale needs a follow-up date right now.");
  };

  const dropProposal = (saleId: string) => setPlan((p) => (p ? { ...p, proposals: p.proposals.filter((x) => x.saleId !== saleId) } : p));

  /** Saves one. Returns whether it saved, so Confirm all stops at the first it can't. */
  const save = async (f: FollowUpView): Promise<boolean> => {
    const { ok, data } = await call(url, "PUT", { saleId: f.saleId, due: f.due });
    if (!ok) {
      setMessage(typeof data.error === "string" ? data.error : DIDNT_WORK);
      // A new array, so the chart puts a dragged bar back where it was.
      setConfirmed((c) => [...c]);
      return false;
    }
    setMessage(null);
    setConfirmed((c) => [...c.filter((x) => x.saleId !== f.saleId), { ...f, state: "confirmed" as const }].sort((a, b) => a.due.localeCompare(b.due)));
    dropProposal(f.saleId);
    return true;
  };

  const confirmAll = async () => {
    setBusy(true);
    for (const f of proposed) if (!(await save(f))) break;
    setBusy(false);
  };

  const dismissSaved = async (saleId: string) => {
    const { ok, data } = await call(url, "DELETE", { saleId });
    if (!ok) return setMessage(typeof data.error === "string" ? data.error : DIDNT_WORK);
    setMessage(null);
    setConfirmed((c) => c.filter((x) => x.saleId !== saleId));
  };

  const move = (saleId: string, due: string) => {
    const f = confirmed.find((x) => x.saleId === saleId);
    if (f && due && due !== f.due) void save({ ...f, due, movedEarlier: false });
  };

  return (
    <>
      <RefundTimelineLoader timeline={timeline} followUps={onChart} onMove={move} />
      <section className="follow-ups" data-testid="follow-ups">
        <h2>Follow-ups</h2>
        <p className="note">Claude proposes. You confirm. Dates are checked against each sale&apos;s refund window. Claude reads CPSC&apos;s public recall text only. It never sees your sales.</p>
        {anyToPlan ? (
          <button type="button" className="btn" onClick={propose} disabled={busy}>
            {busy ? "Planning..." : "Plan follow-ups with Claude"}
          </button>
        ) : null}
        {message ? <p role="status" className="alert" data-testid="follow-up-message">{message}</p> : null}
        {plan && plan.closingSoon > 0 ? <p className="alert" data-testid="closing-soon">{closingSoonLine(plan.closingSoon)}</p> : null}
        {proposed.length > 0 ? (
          <>
            <ul data-testid="follow-up-proposals">
              {proposed.map((f) => (
                <li key={f.saleId}>
                  <strong>{titleOf(f.saleId)}</strong>
                  <span>Follow up by {dayLabel(f.due)}</span>
                  <p className="follow-why">{followUpLines(f).join(" ")}</p>
                  <button type="button" className="btn" disabled={busy} onClick={() => void save(f)}>Confirm</button>
                  <button type="button" className="btn btn-outline" disabled={busy} onClick={() => dropProposal(f.saleId)}>Dismiss</button>
                </li>
              ))}
            </ul>
            {proposed.length > 1 ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void confirmAll()}>Confirm all</button>
            ) : null}
          </>
        ) : null}
        {confirmed.length > 0 ? (
          <ul data-testid="follow-ups-confirmed">
            {confirmed.map((f) => {
              const sale = saleOf(f.saleId);
              return (
                <li key={f.saleId}>
                  <strong>{titleOf(f.saleId)}</strong>
                  <span>Follow up by {dayLabel(f.due)}</span>
                  <p className="follow-why">{followUpLines(f).join(" ")}</p>
                  <label>
                    Change the date{" "}
                    <input type="date" value={f.due} min={timeline.today} max={sale ? latestDay(sale) : undefined} onChange={(e) => move(f.saleId, e.target.value)} />
                  </label>
                  <button type="button" className="btn btn-outline" onClick={() => void dismissSaved(f.saleId)}>Dismiss</button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </>
  );
}
