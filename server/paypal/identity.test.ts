import { describe, expect, it, vi } from "vitest";
import { PayPalApiError } from "./client";
import { authorizeUrl, OWNER_SCOPES, ownerSignInFromEnv, payerIdFromCode } from "./identity";

const CFG = { clientId: "platform-client", clientSecret: "platform-secret", returnUrl: "https://shop.example/api/owner/paypal/return" };

function paypal(answers: { token?: Response; userinfo?: Response }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "https://api-m.sandbox.paypal.com/v1/oauth2/token") return answers.token ?? Response.json({ access_token: "user-token", token_type: "Bearer", expires_in: 28800 });
    if (url === "https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1") return answers.userinfo ?? Response.json({ user_id: "https://www.paypal.com/webapps/auth/identity/user/x", payer_id: "OWNERPAYER12", verified_account: "true" });
    throw new Error(`unexpected ${url}`);
  });
}

describe("Log in with PayPal for a shop owner", () => {
  it("is set up only when the platform app's id and secret are, and comes back to the one return path", () => {
    expect(ownerSignInFromEnv("https://shop.example", { PAYPAL_PLATFORM_CLIENT_ID: "a", PAYPAL_PLATFORM_CLIENT_SECRET: "b" } as unknown as NodeJS.ProcessEnv)).toEqual({ clientId: "a", clientSecret: "b", returnUrl: "https://shop.example/api/owner/paypal/return" });
    expect(ownerSignInFromEnv("https://shop.example", { PAYPAL_PLATFORM_CLIENT_ID: "a" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("sends the owner to PayPal's sandbox sign-in, asking only for the PayPal account id", () => {
    const url = new URL(authorizeUrl(CFG, "STATE123"));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.sandbox.paypal.com/connect/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      flowEntry: "static",
      client_id: "platform-client",
      response_type: "code",
      scope: "openid https://uri.paypal.com/services/paypalattributes",
      redirect_uri: "https://shop.example/api/owner/paypal/return",
      state: "STATE123",
    });
    expect(OWNER_SCOPES).not.toContain("email");
  });

  it("swaps the code for a token with the platform's own credentials, then reads the PayPal account id", async () => {
    const f = paypal({});
    expect(await payerIdFromCode(CFG, "C21AA-code_value.1", f as unknown as typeof fetch)).toBe("OWNERPAYER12");
    const [tokenUrl, tokenInit] = f.mock.calls[0];
    expect(tokenUrl).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(tokenInit?.method).toBe("POST");
    expect(new Headers(tokenInit?.headers).get("authorization")).toBe(`Basic ${Buffer.from("platform-client:platform-secret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit?.body)))).toEqual({ grant_type: "authorization_code", code: "C21AA-code_value.1" });
    const [, infoInit] = f.mock.calls[1];
    expect(new Headers(infoInit?.headers).get("authorization")).toBe("Bearer user-token");
  });

  it("refuses a code that isn't PayPal's form before asking anyone", async () => {
    const f = paypal({});
    await expect(payerIdFromCode(CFG, "a b\nc", f as unknown as typeof fetch)).rejects.toThrow(/sign-in code/);
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps PayPal's own answer when it refuses the code, with its debug id", async () => {
    const refused = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "paypal-debug-id": "dbg9" } });
    const err = await payerIdFromCode(CFG, "C21AA-code", paypal({ token: refused }) as unknown as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ status: 400, issue: "invalid_grant", debugId: "dbg9" });
  });

  it("refuses an answer with no PayPal account id, or one not in PayPal's form", async () => {
    for (const body of [{ user_id: "x" }, { payer_id: "../../x" }, { payer_id: 12345678 }]) {
      await expect(payerIdFromCode(CFG, "C21AA-code", paypal({ userinfo: Response.json(body) }) as unknown as typeof fetch)).rejects.toThrow(/PayPal account id/);
    }
  });
});
