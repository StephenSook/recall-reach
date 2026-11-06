// TEMPORARY, removed in the next commit. Measures how the host builds its proxy headers, so the rate limiter
// can key on something a caller cannot forge. Reports only the shape of the headers: no address leaves here.
export const dynamic = "force-dynamic";

const SENT = "203.0.113.99";

export function GET(request: Request): Response {
  const h = request.headers;
  const parts = (h.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const others = { trueClient: h.get("true-client-ip"), cf: h.get("cf-connecting-ip"), real: h.get("x-real-ip") };
  return Response.json(
    {
      xffParts: parts.length,
      xffFirstIsSent: parts[0] === SENT,
      xffLastIsSent: parts.at(-1) === SENT,
      xffAnyIsSent: parts.includes(SENT),
      trueClient: { present: others.trueClient !== null, isSent: others.trueClient === SENT, equalsXffFirst: others.trueClient === parts[0], equalsXffLast: others.trueClient === parts.at(-1) },
      cf: { present: others.cf !== null, isSent: others.cf === SENT, equalsXffFirst: others.cf === parts[0], equalsXffLast: others.cf === parts.at(-1), equalsTrueClient: others.cf === others.trueClient },
      real: { present: others.real !== null, isSent: others.real === SENT, equalsXffFirst: others.real === parts[0], equalsXffLast: others.real === parts.at(-1) },
      headerNames: [...h.keys()].filter((k) => /ip|forward|cf-|render|real/i.test(k)).sort(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
