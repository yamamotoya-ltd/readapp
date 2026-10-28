export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  QUEUE: Queue<JobMessage>;

  // vars
  TTS_VOICE_JA: string;
  TTS_VOICE_EN: string;
  MONTHLY_CHAR_LIMIT: string;
  MAX_CHARS_PER_EPISODE: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  // secret (wrangler secret put GOOGLE_TTS_API_KEY)
  GOOGLE_TTS_API_KEY: string;
}

export type JobMessage =
  | { episodeId: string; index: number }
  | { episodeId: string; assemble: true };
