import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckWithClaude } from "./CheckWithClaude";

describe("the Check with Claude button", () => {
  const html = renderToStaticMarkup(createElement(CheckWithClaude, { recordId: "r1", here: "#sale-1" }));

  it("is a plain post that works before any script runs", () => {
    expect(html).toContain('action="/api/queue/agent#sale-1"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="recordId" value="r1"');
    expect(html).toContain("Check with Claude");
    expect(html).not.toContain("disabled");
  });
});
