import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const collection = JSON.parse(readFileSync("postman/recall-reach.postman_collection.json", "utf8")) as { variable: { key: string; value: string }[]; item: { name: string; request: { method: string; url: { raw: string; path: string[] } }; event: { script: { exec: string[] } }[] }[] };
const spec = parse(readFileSync("openapi.yaml", "utf8")) as { paths: Record<string, Record<string, unknown>> };
const specShape = (path: string) => path.replace(/\{[^}]+\}/g, "*");

describe("the Postman collection", () => {
  it("calls only what the OpenAPI file documents, with that method", () => {
    const documented = new Map(Object.entries(spec.paths).map(([path, ops]) => [specShape(path), Object.keys(ops)]));
    for (const { request } of collection.item) {
      const path = `/${request.url.path.join("/").replace(/\{\{[^}]+\}\}/g, "*")}`;
      expect(documented.get(path), path).toContain(request.method.toLowerCase());
    }
  });

  it("points at the deployed site, and every request checks its answer", () => {
    expect(collection.variable.find((v) => v.key === "baseUrl")?.value).toBe("https://recall-reach-web-e022.onrender.com");
    for (const item of collection.item) expect(item.event[0].script.exec.join("\n"), item.name).toContain("pm.test(");
  });

  it("writes nothing: the one POST is the MCP tool list", () => {
    const posts = collection.item.filter((i) => i.request.method !== "GET");
    expect(posts.map((i) => i.request.url.path.join("/"))).toEqual(["api/mcp"]);
  });
});
