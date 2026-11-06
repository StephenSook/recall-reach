import { afterEach, describe, expect, it, vi } from "vitest";
import { readSession, SESSION_COOKIE } from "../session/session";
import { fromThisSite, signIn } from "./http";

const post = (origin?: string) => new Request("https://app.example/api/x", { method: "POST", headers: origin === undefined ? {} : { origin } });

describe("signIn", () => {
  const SECRET = "s".repeat(32);
  const cookie = (url: string, lastsMs?: number) =>
    signIn(new Request(url), new Response(null, { status: 303 }), "shop-1", lastsMs).headers.get("set-cookie") ?? "";
  const valueOf = (header: string) => header.slice(`${SESSION_COOKIE}=`.length).split(";")[0];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is Secure on https, and only there, and always HttpOnly", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect(cookie("https://app.example/x")).toMatch(/; HttpOnly; .*; Secure$/);
    expect(cookie("http://localhost/x")).not.toContain("Secure");
  });

  it("is Secure when the outside address is https, whatever the request URL says behind the proxy", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://app.example");
    expect(cookie("http://10.0.0.1:3000/x")).toContain("; Secure");
  });

  it("tells the browser and the signature the same length", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const week = 7 * 86_400_000;
    const header = cookie("https://app.example/x", week);
    expect(header).toContain("Max-Age=604800");
    const after = (days: number) => new Date(Date.now() + days * 86_400_000);
    expect(readSession(SECRET, valueOf(header), after(6))?.shopId).toBe("shop-1");
    expect(readSession(SECRET, valueOf(header), after(8))).toBeNull();
  });

  it("lasts a day unless asked for longer", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect(cookie("https://app.example/x")).toContain("Max-Age=86400");
  });
});

describe("fromThisSite", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a form on this site", () => {
    expect(fromThisSite(post("https://app.example"))).toBe(true);
  });

  it("refuses another site", () => {
    expect(fromThisSite(post("https://evil.example"))).toBe(false);
  });

  it("refuses no Origin at all: every browser form sends one, and a script need not", () => {
    expect(fromThisSite(post())).toBe(false);
  });

  it('refuses the "null" a sandboxed frame sends', () => {
    expect(fromThisSite(post("null"))).toBe(false);
  });

  it("compares with the public address behind the host's proxy", () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://public.example/");
    expect(fromThisSite(new Request("http://internal:10000/api/x", { method: "POST", headers: { origin: "https://public.example" } }))).toBe(true);
    expect(fromThisSite(new Request("http://internal:10000/api/x", { method: "POST", headers: { origin: "http://internal:10000" } }))).toBe(false);
  });
});
