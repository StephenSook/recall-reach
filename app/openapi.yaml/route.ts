import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(readFileSync(join(process.cwd(), "openapi.yaml"), "utf8"), {
    headers: { "content-type": "application/yaml; charset=utf-8", "access-control-allow-origin": "*" },
  });
}
