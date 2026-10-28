import type { Episode } from './types';

export async function insertEpisode(
  db: D1Database,
  e: Pick<Episode, 'id' | 'title' | 'lang' | 'char_count' | 'total_chunks' | 'source_url' | 'created_at'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO episodes (id, title, lang, char_count, total_chunks, status, source_url, created_at)
       VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`,
    )
    .bind(e.id, e.title, e.lang, e.char_count, e.total_chunks, e.source_url, e.created_at)
    .run();
}

export function getEpisode(db: D1Database, id: string): Promise<Episode | null> {
  return db.prepare('SELECT * FROM episodes WHERE id = ?').bind(id).first<Episode>();
}

export async function listEpisodes(db: D1Database, limit = 100): Promise<Episode[]> {
  const { results } = await db
    .prepare('SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<Episode>();
  return results;
}

// Records chunk `index` as finished. The done_chunks = index condition makes a redelivered
// queue message harmless: the second attempt matches no row and adds nothing.
export async function recordChunk(
  db: D1Database,
  id: string,
  index: number,
  bytes: number,
  ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE episodes
       SET done_chunks = done_chunks + 1, audio_bytes = COALESCE(audio_bytes, 0) + ?, audio_ms = audio_ms + ?
       WHERE id = ? AND done_chunks = ? AND status = 'processing'`,
    )
    .bind(bytes, ms, id, index)
    .run();
}

export async function markDone(db: D1Database, id: string, audioKey: string, durationSec: number): Promise<void> {
  await db
    .prepare(`UPDATE episodes SET status = 'done', error = NULL, audio_key = ?, duration_sec = ? WHERE id = ?`)
    .bind(audioKey, durationSec, id)
    .run();
}

export async function markFailed(db: D1Database, id: string, error: string): Promise<void> {
  await db
    .prepare(`UPDATE episodes SET status = 'failed', error = ? WHERE id = ?`)
    .bind(error.slice(0, 500), id)
    .run();
}

export async function markProcessing(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE episodes SET status = 'processing', error = NULL WHERE id = ?`).bind(id).run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getFeedToken(db: D1Database): Promise<string> {
  const existing = await getSetting(db, 'feed_token');
  if (existing) return existing;
  // INSERT OR IGNORE so two first requests at once still end up with the same token.
  await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('feed_token', ?)`).bind(randomToken()).run();
  return (await getSetting(db, 'feed_token'))!;
}

// Replaces the token; the old feed and audio URLs stop working immediately.
export async function rotateFeedToken(db: D1Database): Promise<string> {
  const token = randomToken();
  await setSetting(db, 'feed_token', token);
  return token;
}
