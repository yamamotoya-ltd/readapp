import type { Env, JobMessage } from "./env";
import { handleJob } from "./pipeline";
import { route } from "./routes";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return route(request, env);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      await handleJob(env, msg);
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;
