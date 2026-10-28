export type Lang = 'ja-JP' | 'en-US';

export type EpisodeStatus = 'processing' | 'done' | 'failed';

// One row of the episodes table.
export interface Episode {
  id: string;
  title: string;
  lang: Lang;
  char_count: number;
  total_chunks: number;
  done_chunks: number;
  status: EpisodeStatus;
  error: string | null;
  audio_key: string | null;
  audio_bytes: number | null;
  duration_sec: number | null;
  source_url: string | null;
  created_at: string; // ISO 8601 UTC
}
