import { describe, expect, it, vi } from "vitest";
import { createStudioAdapter } from "./adapter";

const request = { input: [], responseFormat: { type: "text" as const } };
const collect = async (adapter: ReturnType<typeof createStudioAdapter>) => {
  const handler = adapter.executeTurn(request as never);
  const events = [];
  for await (const e of handler.stream) events.push(e);
  return { events, response: await handler.complete };
};

describe("the page's side of a dashboard turn", () => {
  it("sends the turn AG Studio built to this site's route, and hands back its events and output", async () => {
    const send = vi.fn(async () => Response.json({ events: [{ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" }], response: { id: "r", createdAt: 1, output: [], status: "completed" } }));
    const { events, response } = await collect(createStudioAdapter(send as unknown as typeof fetch));
    expect(send).toHaveBeenCalledWith("/api/studio/turn", expect.objectContaining({ method: "POST", body: JSON.stringify(request) }));
    expect(events).toHaveLength(1);
    expect(response.status).toBe("completed");
  });

  it("makes a refusal a failed turn, in the server's words", async () => {
    const send = vi.fn(async () => Response.json({ error: "The dashboard's agent has reached today's limit. Everything else still works." }, { status: 429 }));
    const { events, response } = await collect(createStudioAdapter(send as unknown as typeof fetch));
    expect(events).toEqual([]);
    expect(response).toMatchObject({ status: "failed", error: { message: "The dashboard's agent has reached today's limit. Everything else still works." } });
  });

  it("makes a lost connection a failed turn too, never a thrown one", async () => {
    const send = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    const { response } = await collect(createStudioAdapter(send as unknown as typeof fetch));
    expect(response).toMatchObject({ status: "failed", error: { message: "This page couldn't reach the server. Please try again." } });
  });
});
