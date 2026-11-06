import { afterEach, describe, expect, it, vi } from "vitest";
import { fromThisSite } from "./http";

const post = (origin?: string) => new Request("https://app.example/api/x", { method: "POST", headers: origin === undefined ? {} : { origin } });

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
