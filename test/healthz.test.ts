import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string) => worker.fetch(new Request(`http://example.com${path}`), env, ctx);

describe("scaffold", () => {
  it("GET /healthz returns 200 ok", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown path is behind Access (401 when unauthenticated)", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("episodes table exists after migrations", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("episodes");
  });
});
