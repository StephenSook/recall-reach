import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { createContactCipher } from "../privacy/contactCipher";
import { createRecordKey } from "../privacy/recordKey";
import { PayPalApiError, type Method, type PayPalClient, type RequestOptions } from "./client";
import { PAST_WINDOW_SAMPLE, PayoutRefused, readPayoutFromPayPal, recordPayoutItemEvent, reviewPayout, sendPayout, shopPayout } from "./payouts";

const NOW = new Date("2026-11-07T15:00:00Z");
const SECRET = "k".repeat(32);
const key = createRecordKey("r".repeat(32));
const SESSION = "session-1";
const RECEIVER = "sb-abc@personal.example.com";

function fakePayPal(over: { post?: () => unknown; itemStatus?: string; batchStatus?: string } = {}) {
  const calls: { method: Method; path: string; opts: RequestOptions }[] = [];
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      if (method === "POST") {
        if (over.post) return over.post();
        return { status: 201, data: { batch_header: { payout_batch_id: "RAWBATCH1", batch_status: "PENDING" } } };
      }
      return { status: 200, data: { batch_header: { batch_status: over.batchStatus ?? "SUCCESS" }, items: [{ transaction_status: over.itemStatus ?? "SUCCESS" }] } };
    }) as PayPalClient["request"],
  };
  return { client, calls };
}

describe("a payment past the refund window", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const cipher = () => createContactCipher(SECRET, shopId);
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
  });
  afterEach(async () => {
    await db.close();
  });

  const review = (over: Partial<{ email: string; amount: string; session: string; shop: string }> = {}) =>
    reviewPayout(db, { shopId: over.shop ?? shopId, sessionId: over.session ?? SESSION, email: over.email ?? RECEIVER, amount: over.amount ?? "24.00", cipher: cipher(), now: NOW });
  const approvalOf = async (id: string) => (await db.query<{ request_id: string }>("select request_id from payouts where id = $1", [id])).rows[0]?.request_id ?? "";
  const send = async (id: string, client: PayPalClient, session = SESSION, now = NOW) => sendPayout(db, client, { shopId, sessionId: session, payoutId: id, approvalId: await approvalOf(id), recordKey: key, cipher: cipher(), now });
  const code = (p: Promise<unknown>) => p.then(() => "no refusal", (err: unknown) => (err instanceof PayoutRefused ? err.code : `other: ${String(err)}`));

  describe("the first approval", () => {
    it("records one exact amount, with the email encrypted, and sends nothing", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      expect(pp.calls).toEqual([]);
      const { rows } = await db.query<Record<string, unknown>>("select status, amount_cents, currency, receiver_enc from payouts where id = $1", [id]);
      expect(rows[0]).toMatchObject({ status: "reviewed", amount_cents: 2400, currency: "USD" });
      expect(String(rows[0].receiver_enc)).not.toContain("example.com");
    });

    it("is only for a demo shop: the sandbox app is shared, so another shop can't spend from it", async () => {
      const real = await createShop(db, { name: "Real", kind: "REAL" });
      expect(await code(review({ shop: real }))).toBe("DEMO_ONLY");
    });

    it.each([["0.00"], ["-1"], ["24.01"], ["abc"], ["1e3"], [""]])("refuses the amount %s", async (amount) => {
      expect(await code(review({ amount }))).toBe("BAD_AMOUNT");
    });

    it("takes a smaller amount", async () => {
      expect((await review({ amount: "5.50" })).amountCents).toBe(550);
    });

    it.each([["not an email"], [""], ["a@b"], ["a b@example.com"]])("refuses the email %s", async (email) => {
      expect(await code(review({ email }))).toBe("BAD_EMAIL");
    });

    it("can be redone before it's sent, with one row per sale", async () => {
      await review({ amount: "5.00" });
      await review({ amount: "6.00" });
      const { rows } = await db.query<{ amount_cents: number }>("select amount_cents from payouts");
      expect(rows).toEqual([expect.objectContaining({ amount_cents: 600 })]);
    });
  });

  describe("the second approval", () => {
    it("sends the exact amount to the typed email once, with a note built by code", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      await send(id, pp.client);
      expect(pp.calls).toHaveLength(1);
      const [call] = pp.calls;
      expect(call).toMatchObject({ method: "POST", path: "/v1/payments/payouts" });
      const body = call.opts.body as { sender_batch_header: { sender_batch_id: string }; items: { receiver: string; recipient_type: string; amount: { value: string; currency: string }; note: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ receiver: RECEIVER, recipient_type: "EMAIL", amount: { value: "24.00", currency: "USD" } });
      expect(body.items[0].note).toBe(`From the shop, about a product CPSC recalled: CPSC recall ${PAST_WINDOW_SAMPLE.recallNumber}. Follow the recall steps at cpsc.gov/Recalls. Sandbox test money.`);
      expect(call.opts.requestId).toBe(body.sender_batch_header.sender_batch_id);
    });

    it("an old confirmation can't send a newer amount: it's tied to the review it came from", async () => {
      const pp = fakePayPal();
      const { id } = await review({ amount: "1.00" });
      const old = await approvalOf(id);
      await review({ amount: "24.00" });
      expect(await code(sendPayout(db, pp.client, { shopId, sessionId: SESSION, payoutId: id, approvalId: old, recordKey: key, cipher: cipher(), now: NOW }))).toBe("NOT_VALID");
      expect(pp.calls).toEqual([]);
    });

    it("never reads as paid on the send alone", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      expect((await send(id, pp.client)).status).toBe("unconfirmed");
    });

    it("can't be pressed twice: only one request ever goes", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      await send(id, pp.client);
      expect(await code(send(id, pp.client))).toBe("ALREADY_SENT");
      expect(pp.calls).toHaveLength(1);
    });

    it("two presses at once still send one", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      const results = await Promise.all([code(send(id, pp.client)), code(send(id, pp.client))]);
      expect(results.sort()).toEqual(["ALREADY_SENT", "no refusal"]);
      expect(pp.calls).toHaveLength(1);
    });

    it("belongs to the session that reviewed it", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      expect(await code(send(id, pp.client, "someone-else"))).toBe("NOT_VALID");
      expect(pp.calls).toEqual([]);
    });

    it("runs out", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      expect(await code(send(id, pp.client, SESSION, new Date(NOW.getTime() + 16 * 60_000)))).toBe("NOT_VALID");
      expect(pp.calls).toEqual([]);
    });

    it("won't take another shop's payment", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      const other = await createShop(db, { name: "Other", kind: "DEMO" });
      await expect(sendPayout(db, pp.client, { shopId: other, sessionId: SESSION, payoutId: id, approvalId: await approvalOf(id), recordKey: key, cipher: createContactCipher(SECRET, other), now: NOW })).rejects.toBeInstanceOf(PayoutRefused);
      expect(pp.calls).toEqual([]);
    });

    it("says failed when PayPal clearly refuses", async () => {
      const pp = fakePayPal({
        post: () => {
          throw new PayPalApiError(422, "POST", "/v1/payments/payouts", "INSUFFICIENT_FUNDS");
        },
      });
      const { id } = await review();
      expect(await send(id, pp.client)).toMatchObject({ status: "failed", paypalStatus: "INSUFFICIENT_FUNDS" });
    });

    it("says unconfirmed when PayPal's answer is lost, and offers no repeat", async () => {
      const pp = fakePayPal({
        post: () => {
          throw new Error("PayPal gave no answer");
        },
      });
      const { id } = await review();
      expect((await send(id, pp.client)).status).toBe("unconfirmed");
      expect(await code(send(id, pp.client))).toBe("ALREADY_SENT");
    });

    it("keeps PayPal's id only in the table purged at 46 hours, and a keyed hash in the ledger", async () => {
      const pp = fakePayPal();
      const { id } = await review();
      await send(id, pp.client);
      const { rows } = await db.query<Record<string, unknown>>("select * from payouts where id = $1", [id]);
      expect(JSON.stringify(rows)).not.toContain("RAWBATCH1");
      expect(rows[0].batch_ref_hmac).toBeTruthy();
      const refs = await db.query<{ batch_id: string }>("select batch_id from paypal_payout_refs");
      expect(refs.rows[0].batch_id).toBe("RAWBATCH1");
    });
  });

  describe("reading it back", () => {
    const sent = async (itemStatus: string) => {
      const pp = fakePayPal({ itemStatus });
      const { id } = await review();
      await send(id, pp.client);
      return { id, read: await readPayoutFromPayPal(db, pp.client, { shopId, payoutId: id, now: NOW }), pp };
    };

    it("reads as paid only when PayPal's item says SUCCESS", async () => {
      expect((await sent("SUCCESS")).read).toMatchObject({ status: "paid", paypalStatus: "SUCCESS" });
    });

    it.each([
      ["UNCLAIMED", "unclaimed"],
      ["PENDING", "unconfirmed"],
      ["ONHOLD", "unconfirmed"],
      ["FAILED", "failed"],
      ["RETURNED", "failed"],
      ["BLOCKED", "failed"],
      ["REFUNDED", "failed"],
      ["SOMETHING_NEW", "unconfirmed"],
    ])("reads PayPal's %s as %s", async (paypal, status) => {
      expect((await sent(paypal)).read).toMatchObject({ status, paypalStatus: paypal });
    });

    it("has nothing to read once PayPal's id is purged, and says so", async () => {
      const { id, pp } = await sent("PENDING");
      await db.query("delete from paypal_payout_refs");
      expect(await code(readPayoutFromPayPal(db, pp.client, { shopId, payoutId: id, now: NOW }))).toBe("AGED_OUT");
    });

    it("says so when PayPal's answer was lost and there's no id to read, and sends nothing", async () => {
      const lost = fakePayPal({
        post: () => {
          throw new Error("PayPal gave no answer");
        },
      });
      const { id } = await review();
      await send(id, lost.client);
      expect(await code(readPayoutFromPayPal(db, lost.client, { shopId, payoutId: id, now: NOW }))).toBe("NO_ANSWER");
      expect(lost.calls).toHaveLength(1);
    });
  });

  describe("PayPal's item webhook", () => {
    const hook = (status: string) => recordPayoutItemEvent(db, key, { payout_batch_id: "RAWBATCH1", transaction_status: status });
    const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from payouts where id = $1", [id])).rows[0].status;

    it("reads a final answer", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      expect(await hook("SUCCESS")).toBe(true);
      expect(await statusOf(id)).toBe("paid");
    });

    it("a late event can't move a final answer back to waiting", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      await hook("SUCCESS");
      await hook("PENDING");
      expect(await statusOf(id)).toBe("paid");
    });

    it("a late UNCLAIMED can't undo paid, and a later reversal can", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      await hook("SUCCESS");
      await hook("UNCLAIMED");
      expect(await statusOf(id)).toBe("paid");
      await hook("REVERSED");
      expect(await statusOf(id)).toBe("failed");
    });

    it("a final answer that arrives while the send is still finishing stands", async () => {
      const { id } = await review();
      let delivered = false;
      const racing: PayPalClient = {
        request: (async (method: string, path: string, opts: unknown) => {
          const answer = await fakePayPal().client.request(method as "POST", path, opts as never);
          if (method === "POST") {
            delivered = true;
            await db.query("update payouts set batch_ref_hmac = $2 where id = $1", [id, key("paypal-resource", "RAWBATCH1")]);
            await hook("SUCCESS");
          }
          return answer;
        }) as PayPalClient["request"],
      };
      expect((await send(id, racing)).status).toBe("paid");
      expect(delivered).toBe(true);
      expect(await statusOf(id)).toBe("paid");
    });

    it("finds the payment by the approval it carries when the send's answer was lost, and can read it after", async () => {
      const lost = fakePayPal({
        post: () => {
          throw new Error("PayPal gave no answer");
        },
      });
      const { id } = await review();
      await send(id, lost.client);
      const approval = lost.calls[0].opts as { body: { items: { sender_item_id: string }[] } };
      expect(await recordPayoutItemEvent(db, key, { payout_batch_id: "RAWBATCH1", transaction_status: "SUCCESS", payout_item: { sender_item_id: approval.body.items[0].sender_item_id } })).toBe(true);
      expect(await statusOf(id)).toBe("paid");
      expect((await db.query<{ batch_id: string }>("select batch_id from paypal_payout_refs")).rows[0].batch_id).toBe("RAWBATCH1");
      const again = fakePayPal({ itemStatus: "SUCCESS" });
      expect(await readPayoutFromPayPal(db, again.client, { shopId, payoutId: id, now: NOW })).toMatchObject({ status: "paid" });
    });

    it("an event carrying another shop's approval or an unknown one changes nothing", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      expect(await recordPayoutItemEvent(db, key, { payout_batch_id: "OTHER", transaction_status: "SUCCESS", payout_item: { sender_item_id: "00000000-0000-4000-8000-000000000009" } })).toBe(false);
      expect(await statusOf(id)).toBe("unconfirmed");
    });

    it("a read finishing after a final answer can't undo it", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      const slow: PayPalClient = {
        request: (async (method: string, path: string, opts: unknown) => {
          const answer = await fakePayPal({ itemStatus: "PENDING" }).client.request(method as "GET", path, opts as never);
          await hook("SUCCESS");
          return answer;
        }) as PayPalClient["request"],
      };
      await readPayoutFromPayPal(db, slow, { shopId, payoutId: id, now: NOW });
      expect(await statusOf(id)).toBe("paid");
    });

    it("a read still running when the owner reviews again doesn't touch the new review", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      await hook("RETURNED");
      const slow: PayPalClient = {
        request: (async (method: string, path: string, opts: unknown) => {
          const answer = await fakePayPal({ itemStatus: "SUCCESS" }).client.request(method as "GET", path, opts as never);
          await review({ amount: "2.00" });
          return answer;
        }) as PayPalClient["request"],
      };
      await readPayoutFromPayPal(db, slow, { shopId, payoutId: id, now: NOW });
      expect(await statusOf(id)).toBe("reviewed");
    });

    it("a batch PayPal returned is forgotten when the owner reviews again", async () => {
      const { id } = await review();
      await send(id, fakePayPal().client);
      await hook("RETURNED");
      expect(await statusOf(id)).toBe("failed");
      await review({ amount: "5.00" });
      expect((await db.query("select 1 from paypal_payout_refs")).rows).toEqual([]);
      expect(await hook("SUCCESS")).toBe(false);
      expect(await statusOf(id)).toBe("reviewed");
    });
  });

  it("each approval is its own batch id, so PayPal itself refuses a repeat of one", async () => {
    const refused = fakePayPal({
      post: () => {
        throw new PayPalApiError(422, "POST", "/v1/payments/payouts", "INSUFFICIENT_FUNDS");
      },
    });
    const first = await review();
    await send(first.id, refused.client);
    const second = await review();
    await send(second.id, refused.client);
    const ids = refused.calls.map((c) => (c.opts.body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header.sender_batch_id);
    expect(new Set(ids).size).toBe(2);
    const { rows } = await db.query<{ request_id: string }>("select request_id from payouts where id = $1", [second.id]);
    expect(ids[1]).toBe(rows[0].request_id);
  });

  describe("what the shop's card reads", () => {
    it("shows the email back only to this shop, and the sample's facts", async () => {
      await review();
      const p = await shopPayout(db, shopId, cipher());
      expect(p).toMatchObject({ status: "reviewed", receiver: RECEIVER, amountCents: 2400 });
    });

    it("is nothing before a review", async () => {
      expect(await shopPayout(db, shopId, cipher())).toBeNull();
    });
  });

  it("goes when the shop goes", async () => {
    await review();
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select 1 from payouts")).rows).toEqual([]);
  });
});
