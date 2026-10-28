import type { Env, JobMessage } from "./env";

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async queue(batch: MessageBatch<JobMessage>, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // TODO: delegate to pipeline.ts (Task 6)
    for (const msg of batch.messages) {
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;
