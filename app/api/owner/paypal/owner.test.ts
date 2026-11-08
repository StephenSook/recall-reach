import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { createRecordKey } from "@/server/privacy/recordKey";
import { sessionCookie } from "@/server/session/session";

vi.mock("@/server/db/pg", () => ({ getDb: vi.fn() }));
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (jar.values.has(name) ? { value: jar.values.get(name) } : undefined) }) }));
const payer = vi.hoisted(() => ({ id: "OWNERPAYER12" as string | Error, asked: 0 }));
vi.mock("@/server/paypal/identity", async (original) => ({
  ...(await original<typeof import("@/server/paypal/identity")>()),
  payerIdFromCode: async () => {
    payer.asked += 1;
    if (payer.id instanceof Error) throw payer.id;
    return payer.id;
  },
}));

import { getDb } from "@/server/db/pg";
import { shopForOwner } from "@/server/owner/ownerLink";
import { POST as start } from "./start/route";
import { GET as back } from "./return/route";

const SESSION = "s".repeat(64);
const RECORD = "r".repeat(64);
const BASE = "http://localhost:3000";
const key = createRecordKey(RECORD);

describe("Log in with PayPal for a shop owner", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let ip = 0;
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", SESSION);
    vi.stubEnv("RECORD_HMAC_SECRET", RECORD);
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    vi.stubEnv("PAYPAL_PLATFORM_CLIENT_ID", "platform-client");
    vi.stubEnv("PAYPAL_PLATFORM_CLIENT_SECRET", "platform-secret");
    db = await testDb();
    await migrate(db);
    vi.mocked(getDb).mockReturnValue(db);
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
    jar.values.clear();
    payer.id = "OWNERPAYER12";
    payer.asked = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  const signedInAs = (shop: string) => jar.values.set("rr_session", sessionCookie(SESSION, shop).value);
  const press = (intent: "link" | "signin", origin = BASE) => {
    const form = new FormData();
    form.set("intent", intent);
    return start(new Request(`${BASE}/api/owner/paypal/start`, { method: "POST", headers: { origin, "true-client-ip": `198.51.100.${++ip}` }, body: form }));
  };
  const comeBack = (query: string) => back(new Request(`${BASE}/api/owner/paypal/return?${query}`, { headers: { "true-client-ip": `198.51.100.${++ip}` } }));
  /** Presses start, then comes back the way PayPal would, carrying the state and the cookie start set. */
  const roundTrip = async (intent: "link" | "signin", tamper: (state: string) => string = (s) => s, extra = "&code=C21AA-code") => {
    const res = await press(intent);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    jar.values.set("rr_owner_paypal", /rr_owner_paypal=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]);
    return comeBack(`state=${encodeURIComponent(tamper(state))}${extra}`);
  };
  const location = (res: Response) => new URL(res.headers.get("location")!, BASE);

  it("sends the owner to PayPal's sandbox sign-in with a fresh state, held in a short HttpOnly cookie for the return path only", async () => {
    const res = await press("signin");
    expect(res.status).toBe(303);
    const to = location(res);
    expect(`${to.origin}${to.pathname}`).toBe("https://www.sandbox.paypal.com/connect/");
    expect(to.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(res.headers.get("set-cookie")).toMatch(/^rr_owner_paypal=[^;]+; Path=\/api\/owner\/paypal; HttpOnly; SameSite=Lax; Max-Age=600$/);
  });

  it("refuses to start from another site, to link without the shop's session, or to link a demo shop", async () => {
    expect((await press("signin", "https://evil.example")).status).toBe(403);
    expect((await press("link")).status).toBe(401);
    const demo = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    signedInAs(demo);
    expect(location(await press("link")).pathname).toBe("/queue");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
  });

  it("links the signed-in shop to the PayPal login that comes back, and clears the state cookie", async () => {
    signedInAs(shopId);
    const res = await roundTrip("link");
    expect(location(res).pathname).toBe("/queue");
    expect(res.headers.get("set-cookie")).toContain("rr_owner_paypal=; Path=/api/owner/paypal; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBe(shopId);
  });

  it("won't link when the browser that comes back holds a different shop's session than the one that started", async () => {
    signedInAs(shopId);
    const res = await press("link");
    const state = location(res).searchParams.get("state")!;
    jar.values.set("rr_owner_paypal", /rr_owner_paypal=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]);
    signedInAs(await createShop(db, { name: "B SHOP", kind: "REAL" }));
    expect((await comeBack(`state=${state}&code=C21AA-code`)).status).toBe(401);
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
  });

  it("refuses a return whose state isn't this browser's, without asking PayPal", async () => {
    signedInAs(shopId);
    payer.id = new Error("PayPal must not be asked");
    const res = await roundTrip("link", (s) => `${s.slice(0, -2)}xx`);
    expect(location(res).searchParams.get("error")).toBe("OWNER_EXPIRED");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
  });

  it("says so when the owner leaves PayPal's page, or PayPal doesn't confirm", async () => {
    expect(location(await roundTrip("signin", (s) => s, "&error=access_denied")).searchParams.get("error")).toBe("OWNER_CANCELLED");
    payer.id = new Error("PayPal 400");
    expect(location(await roundTrip("signin")).searchParams.get("error")).toBe("OWNER_FAILED");
  });

  it("opens the linked shop in a new session, and says plainly when a login opens no shop", async () => {
    expect(location(await roundTrip("signin")).searchParams.get("error")).toBe("OWNER_NOT_LINKED");
    signedInAs(shopId);
    await roundTrip("link");
    const old = jar.values.get("rr_session")!;
    jar.values.delete("rr_session");
    const res = await roundTrip("signin");
    expect(location(res).pathname).toBe("/queue");
    const issued = /rr_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    expect(issued.split(".")[0]).toBe(shopId);
    expect(issued.split(".")[1]).not.toBe(old.split(".")[1]);
    const { rows } = await db.query<{ owner_signed_in_at: unknown }>("select owner_signed_in_at from shops where id = $1", [shopId]);
    expect(rows[0].owner_signed_in_at).not.toBeNull();
  });

  it("uses each sign-in's state once: a second return with the same cookie and state is refused without asking PayPal", async () => {
    const res = await press("signin");
    const state = location(res).searchParams.get("state")!;
    jar.values.set("rr_owner_paypal", /rr_owner_paypal=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]);
    await comeBack(`state=${state}&code=C21AA-code`);
    expect(payer.asked).toBe(1);
    expect(location(await comeBack(`state=${state}&code=C21AA-other`)).searchParams.get("error")).toBe("OWNER_EXPIRED");
    expect(payer.asked).toBe(1);
  });

  it("limits returns from one visitor before PayPal is asked", async () => {
    const res = await press("signin");
    const state = location(res).searchParams.get("state")!;
    jar.values.set("rr_owner_paypal", /rr_owner_paypal=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]);
    const from = (n: number) => back(new Request(`${BASE}/api/owner/paypal/return?state=${state}x&code=C21AA-code`, { headers: { "true-client-ip": "203.0.113.77" } })).then(() => n);
    for (let i = 0; i < 40; i += 1) await from(i);
    const last = await back(new Request(`${BASE}/api/owner/paypal/return?state=${state}&code=C21AA-code`, { headers: { "true-client-ip": "203.0.113.77" } }));
    expect(location(last).searchParams.get("error")).toBe("OWNER_BUSY");
    expect(payer.asked).toBe(0);
  });

  it("refuses an oversized start before reading it all", async () => {
    const big = new FormData();
    big.set("intent", "signin");
    big.set("pad", "x".repeat(64_000));
    const res = await start(new Request(`${BASE}/api/owner/paypal/start`, { method: "POST", headers: { origin: BASE, "true-client-ip": "198.51.100.250" }, body: big }));
    expect(res.status).toBe(413);
  });

  it("won't open a shop whose data is about to be deleted", async () => {
    signedInAs(shopId);
    await roundTrip("link");
    await db.query("update shops set created_at = now() - interval '7 days' + interval '30 seconds' where id = $1", [shopId]);
    jar.values.delete("rr_session");
    expect(location(await roundTrip("signin")).searchParams.get("error")).toBe("OWNER_SHOP_GONE");
  });
});
