import { describe, expect, it, vi } from "vitest";
import { startReplayTask } from "./startReplayTask";

const ENV = { RENDER_API_KEY: "rnd_SENTINEL", REPLAY_WORKFLOW_TASK: "recall-reach-replay/refresh_replay" };

describe("starting the daily Replay refresh", () => {
  it("names the task, sends no arguments, and carries the key only in its header", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 201 }));
    await expect(startReplayTask(ENV, f as unknown as typeof fetch)).resolves.toBe("started");
    expect(f.mock.calls[0][0]).toBe("https://api.render.com/v1/task-runs");
    expect(JSON.parse(String(f.mock.calls[0][1].body))).toEqual({ task: "recall-reach-replay/refresh_replay", input: [] });
    expect(String(f.mock.calls[0][1].body)).not.toContain("SENTINEL");
    expect(f.mock.calls[0][1].headers).toMatchObject({ authorization: "Bearer rnd_SENTINEL" });
  });

  it.each([[{}], [{ RENDER_API_KEY: "k" }], [{ REPLAY_WORKFLOW_TASK: "t" }], [{ RENDER_API_KEY: "", REPLAY_WORKFLOW_TASK: "t" }]])("fails with %j, so a missing key shows red, and calls no one", async (env) => {
    const f = vi.fn();
    await expect(startReplayTask(env, f as unknown as typeof fetch)).rejects.toThrow("missing");
    expect(f).not.toHaveBeenCalled();
  });

  it("says it failed, with the status and without the key", async () => {
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const failure = await startReplayTask(ENV, f as unknown as typeof fetch).catch((e: Error) => e.message);
    expect(failure).toBe("Render answered 401");
  });
});
