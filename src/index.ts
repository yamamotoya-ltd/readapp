import type { Env, JobMessage } from "./env";
import { handleJob } from "./pipeline";

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      await handleJob(env, msg);
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;
