CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lang TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  done_chunks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('processing','done','failed')),
  error TEXT,
  audio_key TEXT,
  audio_bytes INTEGER,
  duration_sec INTEGER,
  source_url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_episodes_created_at ON episodes(created_at);

CREATE TABLE usage (
  month TEXT PRIMARY KEY,
  chars_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
