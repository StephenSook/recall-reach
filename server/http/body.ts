export type CappedBody = { ok: true; body: Uint8Array } | { ok: false };

/**
 * Reads a request or response body but never holds more than maxBytes: a declared Content-Length over the
 * limit is refused before reading, and a streamed body is cancelled as soon as it passes the limit.
 */
export async function readCappedBody(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
  opts: { timeoutMs?: number } = {},
): Promise<CappedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => {});
    return { ok: false };
  }
  if (!request.body) return { ok: true, body: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // One timer for the whole body. A deadline per chunk would let a byte every few seconds hold a request open for hours.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp =
    opts.timeoutMs === undefined
      ? null
      : new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), opts.timeoutMs);
        });
  try {
    for (;;) {
      const next = await (gaveUp ? Promise.race([reader.read(), gaveUp]) : reader.read());
      if (next === null) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      const { done, value } = next;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}
