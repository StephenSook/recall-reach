// AG Studio's agent asks for one turn at a time. Each goes to this site's /api/studio/turn, which asks Claude, and the
// answer comes back in AG Studio's own shapes. A refusal or a failure becomes a failed turn, with the server's sentence.
import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgLlmResponseHandler } from "ag-studio";

const failed = (message: string): AgLlmResponse => ({ id: "failed", createdAt: Date.now(), output: [], status: "failed", error: { code: "turn_failed", message } });

export function createStudioAdapter(send: typeof fetch = (input, init) => fetch(input, init)): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options): AgLlmResponseHandler {
      const answer = (async (): Promise<{ events: AgAiEvent[]; response: AgLlmResponse }> => {
        try {
          const res = await send("/api/studio/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          const body = (await res.json().catch(() => null)) as { events?: AgAiEvent[]; response?: AgLlmResponse; error?: string } | null;
          if (!res.ok || !body?.response) return { events: [], response: failed(body?.error ?? "The dashboard's agent didn't answer. Please try again.") };
          return { events: body.events ?? [], response: body.response };
        } catch (err) {
          if (options?.signal?.aborted) return { events: [], response: { ...failed("Stopped."), status: "cancelled" } };
          return { events: [], response: failed(err instanceof Error && err.name === "TypeError" ? "This page couldn't reach the server. Please try again." : "The dashboard's agent didn't answer. Please try again.") };
        }
      })();
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            for (const event of (await answer).events) yield event;
          },
        },
        complete: answer.then((a) => a.response),
      };
    },
  };
}
