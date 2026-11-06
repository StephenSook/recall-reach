import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { QUEUE, SITE, staysInApp, tokenScript, urlFromPush } from "./links";

const CARD = "/queue#sale-00000000-0000-4000-8000-000000000001";
const TOKEN = "ExponentPushToken[abcDEF123_-]";

describe("what stays in the app's web view", () => {
  it.each([QUEUE, SITE, `${SITE}/`, `${SITE}/check?error=BUSY`, `${SITE}#x`, "https://www.sandbox.paypal.com/checkoutnow?token=x", "about:blank"])("%s stays", (url) => {
    expect(staysInApp(url)).toBe(true);
  });

  it.each([
    "https://www.cpsc.gov/Recalls/2026/x",
    "mailto:family@example.test?subject=x",
    "tel:5551234",
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "http://recall-reach-web-e022.onrender.com/queue",
    "https://recall-reach-web-e022.onrender.com.evil.example/queue",
    "https://recall-reach-web-e022.onrender.com@evil.example/queue",
    "https://evil.example/https://recall-reach-web-e022.onrender.com/",
    "https://www.paypal.com/checkoutnow",
    "https://www.sandbox.paypal.com.evil.example/",
  ])("%s goes outside", (url) => {
    expect(staysInApp(url)).toBe(false);
  });
});

describe("where tapping a push goes", () => {
  it("opens that card on the queue", () => {
    expect(urlFromPush({ path: CARD })).toBe(`${SITE}${CARD}`);
    expect(urlFromPush({ path: "/queue" })).toBe(QUEUE);
  });

  it.each([
    [null],
    [undefined],
    ["/queue"],
    [{}],
    [{ path: 7 }],
    [{ path: "https://evil.example/" }],
    [{ path: "//evil.example/queue" }],
    [{ path: "/queue/../admin" }],
    [{ path: "/queue#sale-not-a-card" }],
    [{ path: "/queue?x=1" }],
    [{ path: `${CARD}\n` }],
    [{ path: "/check" }],
  ])("ignores %j", (data) => {
    expect(urlFromPush(data)).toBeNull();
  });
});

describe("handing the token to the page", () => {
  const run = (script: string, origin: string) => {
    const events: string[] = [];
    const window: { recallReachPushToken?: string; dispatchEvent: (e: { type: string }) => void } = { dispatchEvent: (e) => events.push(e.type) };
    runInNewContext(script, { location: { origin }, window, Event: class { constructor(readonly type: string) {} } });
    return { token: window.recallReachPushToken, events };
  };

  it("gives it to the site's own page and says so", () => {
    expect(run(tokenScript(TOKEN), SITE)).toEqual({ token: TOKEN, events: ["recall-reach-push-token"] });
  });

  it("gives it to no other page, such as PayPal's", () => {
    expect(run(tokenScript(TOKEN), "https://www.sandbox.paypal.com")).toEqual({ token: undefined, events: [] });
  });

  it("won't write anything that isn't a push token into a page", () => {
    expect(tokenScript('x"];alert(1);//')).toBe("true;");
    expect(tokenScript("ExponentPushToken[a]; alert(1)")).toBe("true;");
  });
});
