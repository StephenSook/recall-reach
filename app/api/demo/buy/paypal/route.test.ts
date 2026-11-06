import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutState } from "@/server/demo/liveCatch";
import { sessionCookie } from "@/server/session/session";
import { POST } from "./route";
import { GET } from "./return/route";

const SITE = "http://localhost";
const SECRET = "s".repeat(32);
const SHOP = "11111111-1111-4111-8111-111111111111";
let cookie: string | undefined;

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }) }));

const post = (origin: string | null = SITE) =>
  POST(new Request(`${SITE}/api/demo/buy/paypal`, { method: "POST", headers: origin ? { origin } : {}, body: new URLSearchParams({ shopItemId: "not-a-uuid" }) }));
const back = (query: string) => GET(new Request(`${SITE}/api/demo/buy/paypal/return?${query}`));

describe("the PayPal buy routes", () => {
  beforeEach(() => {
    cookie = undefined;
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    vi.stubEnv("PAYPAL_CLIENT_ID", "id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    vi.stubEnv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/none");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const signedIn = () => {
    cookie = sessionCookie(SECRET, SHOP, new Date(), 3_600_000).value;
  };

  it("won't start a sale with no session, or from another site", async () => {
    expect((await post()).status).toBe(401);
    signedIn();
    expect((await post("https://evil.example")).status).toBe(401);
    expect((await post(null)).status).toBe(401);
  });

  it("sends a return with no session home, touching nothing", async () => {
    const res = await back("state=x&token=y");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/`);
  });

  it("says a cancel sold nothing", async () => {
    signedIn();
    const res = await back("cancelled=1&token=ORDER1");
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("You cancelled at PayPal. Nothing was sold.");
  });

  it("refuses a state it didn't sign, before reaching the database or PayPal", async () => {
    signedIn();
    const res = await back("state=forged&token=ORDER1");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("That item can't be bought here.");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps PayPal's ids out of what it logs when something fails", async () => {
    const item = `${"a".repeat(8)}-aaaa-4aaa-8aaa-${"a".repeat(12)}`;
    const { value, sessionId } = sessionCookie(SECRET, SHOP, new Date(), 3_600_000);
    cookie = value;
    const state = checkoutState(SECRET, SHOP, sessionId, item, `DEMO-LIVE-${"a".repeat(12)}`);
    // A valid state against a database that isn't there, so this really reaches the failure path.
    const res = await back(`state=${encodeURIComponent(state)}&token=ORDER1SENTINEL&PayerID=PAYER1SENTINEL`);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("The sale did not go through.");
    expect(console.error).toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("ORDER1SENTINEL");
    expect(logged).not.toContain("PAYER1SENTINEL");
  });
});
