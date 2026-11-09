"use client";

import { useState } from "react";
import type { ShopperView } from "@/app/api/shopper/run/route";
import { SHOPPER_EXAMPLES } from "@/server/shopper/examples";
import { AgentTools } from "./AgentTools";

// The same list the server records runs of, so a recorded example always matches a chip.
const CHIPS = SHOPPER_EXAMPLES;

const money = (cents: number) => `${(cents / 100).toFixed(2)} USD`;

const SAID: Record<Exclude<ShopperView["outcome"], "PICKED">, string> = {
  NO_PICK: "The agent didn't find one it could offer in that budget. Try other words or a higher budget.",
  STEP_LIMIT: "The agent ran out of steps before it could offer one. Try other words.",
  REFUSED: "Claude declined that request. Try other words.",
  OVER_BUDGET: "The agent has reached today's limit. Everything else on the site still works.",
  UNAVAILABLE: "The agent isn't available right now. Everything else on the site still works.",
  BUSY: "Too many tries from here. Try again in an hour.",
};

const CHECK_WORDS = { NAMES_A_RECALL: "its words match a recall", NO_MATCH_FOUND: "no recall match found", COULD_NOT_FINISH: "the check couldn't finish", MAKER_NOT_RULED_OUT: "a recall from this maker can't be ruled out" } as const;

function Steps({ steps }: { steps: ShopperView["steps"] }) {
  if (steps.length === 0) return null;
  return (
    <details className="window shopper-result" data-testid="shopper-steps">
      <summary>What the agent did ({steps.length} steps)</summary>
      <ol>
        {steps.map((step, i) =>
          step.kind === "search" ? (
            <li key={i}>
              Searched for &quot;{step.query}&quot;: {step.found} listings, {step.inBudget} in budget.
            </li>
          ) : (
            <li key={i}>
              Checked {step.title}: {CHECK_WORDS[step.result]}
              {step.recalls.length > 0 ? ` (CPSC recall ${step.recalls.join(", ")})` : ""}.
            </li>
          ),
        )}
      </ol>
    </details>
  );
}

export function ShopperForm() {
  const [ask, setAsk] = useState("");
  const [budget, setBudget] = useState("50");
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<ShopperView | null>(null);
  const [failed, setFailed] = useState(false);

  const run = async (nextAsk: string, nextBudget: string) => {
    setRunning(true);
    setView(null);
    setFailed(false);
    try {
      const res = await fetch("/api/shopper/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ask: nextAsk, budget: Number(nextBudget) }) });
      if (res.status === 400) setFailed(true);
      else setView((await res.json()) as ShopperView);
    } catch {
      setFailed(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <form
        className="window upload"
        data-testid="shopper-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(ask, budget);
        }}
      >
        <label className="field">
          What are you looking for?
          <input name="ask" value={ask} maxLength={200} required onChange={(e) => setAsk(e.target.value)} />
        </label>
        <label className="field">
          Your budget in USD
          <input name="budget" type="number" min={1} max={2000} value={budget} required onChange={(e) => setBudget(e.target.value)} />
        </label>
        <div className="actions">
          {CHIPS.map((chip) => (
            <button
              key={chip.ask}
              type="button"
              className="btn btn-outline"
              disabled={running}
              onClick={() => {
                setAsk(chip.ask);
                setBudget(String(chip.budget));
                void run(chip.ask, String(chip.budget));
              }}
            >
              {chip.ask}, {chip.budget} USD
            </button>
          ))}
        </div>
        <button type="submit" className="btn big" disabled={running}>
          {running ? "The agent is working" : "Find one"}
        </button>
        {running ? (
          <p className="note" role="status" data-testid="shopper-running">
            This can take a minute. Please keep this page open.
          </p>
        ) : null}
      </form>
      {failed ? (
        <p role="alert" className="alert">
          Give what you&apos;re looking for and a budget from 1 to 2000, then try again.
        </p>
      ) : null}
      {view && view.outcome !== "PICKED" ? <p role="status" data-testid="shopper-said">{SAID[view.outcome]}</p> : null}
      {view
        ? view.blocked.map((b) => (
            <article key={b.title} className="window shopper-result" data-testid="shopper-blocked">
              <h2 className="section-title">Not offered: {b.title}</h2>
              <p>{money(b.priceCents)}. This listing&apos;s words match a recall: its model, or its maker and product line. That doesn&apos;t say this item is recalled or that a store did anything wrong. The agent can&apos;t offer it, so a person should read the recall.</p>
              <ul>
                {b.recalls.map((r) => (
                  <li key={r.number}>
                    CPSC recall {r.number}: {r.url ? <a href={r.url}>{r.title}</a> : r.title}
                  </li>
                ))}
              </ul>
            </article>
          ))
        : null}
      {view?.pick ? (
        <article className="window shopper-result" data-testid="shopper-pick">
          <h2 className="section-title">Offered: {view.pick.title}</h2>
          <p>
            {view.pick.brand ? `${view.pick.brand}. ` : ""}
            {money(view.pick.priceCents)}.
          </p>
          <p>
            We didn&apos;t find a recall naming this maker and product line, or its model, in {view.pick.recallsChecked.toLocaleString("en-US")} CPSC recalls{view.pick.from ? ` since ${view.pick.from.slice(0, 4)}` : ""}.{view.pick.similar > 0 ? ` ${view.pick.similar} recall${view.pick.similar === 1 ? " of the same kind of product doesn't" : "s of the same kind of product don't"} name this maker or model.` : ""} That doesn&apos;t mean it&apos;s safe. Check the model on the product at cpsc.gov/Recalls.
          </p>
          <form action="/api/shopper/buy" method="post">
            <input type="hidden" name="slip" value={view.pick.slipId} />
            <button type="submit" className="btn big">
              Approve on PayPal (sandbox)
            </button>
          </form>
          <p className="note">This offer lasts {view.pick.minutes} minutes and works once. The price and the recall check are read again when you press.</p>
        </article>
      ) : null}
      {view ? <Steps steps={view.steps} /> : null}
      <AgentTools />
    </>
  );
}
