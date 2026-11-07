import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({ Jost: () => ({ variable: "font" }) }));
vi.mock("./globals.css", () => ({}));

import { metadata } from "./layout";

describe("how a shared link looks", () => {
  it("names the site, and gives a full address for the image", () => {
    expect(String(metadata.metadataBase)).toBe("https://recall-reach-web-e022.onrender.com/");
    expect(metadata.openGraph).toMatchObject({ siteName: "Recall Reach", images: [{ url: "/og.png", width: 1200, height: 630 }] });
  });

  it("has that image, at the size it says", () => {
    const png = readFileSync("public/og.png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});
