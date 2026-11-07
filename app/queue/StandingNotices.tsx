/** Closed by default, inside the card's own details. Only for a sale the check reads as a match. */
export function StandingNotices({ recallNumber, on, here }: { recallNumber: string; on: boolean; here: string }) {
  const action = `/api/queue/standing${here}`;
  if (on) {
    return (
      <form action={action} method="post" data-testid="standing-on">
        <input type="hidden" name="recallNumber" value={recallNumber} />
        <input type="hidden" name="action" value="off" />
        <p>On for recall {recallNumber}: notices are prepared for you, and you still send each one.</p>
        <button type="submit" className="btn btn-outline">
          Turn off
        </button>
      </form>
    );
  }
  return (
    <details data-testid="standing">
      <summary>Prepare every notice for this recall</summary>
      <p>New sales the check reads as a match get a notice ready without you approving each one. A sale it can&apos;t tell about still asks you. Nothing sends by itself: each one still opens in your mail, and you send it. Refunds still need you every time.</p>
      <form action={action} method="post">
        <input type="hidden" name="recallNumber" value={recallNumber} />
        <label className="field">
          Type the recall number to turn this on <input name="typed" autoComplete="off" required />
        </label>
        <button type="submit" className="btn btn-outline">
          Turn on for recall {recallNumber}
        </button>
      </form>
    </details>
  );
}
