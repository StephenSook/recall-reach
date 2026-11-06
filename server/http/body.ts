export type CappedBody = { ok: true; body: Uint8Array } | { ok: false };

/** The next chunk, or null if it doesn't come in time. */
async function readOrGiveUp(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const next = await Promise.race([reader.read(), gaveUp]);
  clearTimeout(timer);
  return next;
}

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
  for (;;) {
    const next = await (opts.timeoutMs === undefined ? reader.read() : readOrGiveUp(reader, opts.timeoutMs));
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
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}
