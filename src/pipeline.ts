// Turns a pasted text into one podcast episode.
//
// createEpisode  checks limits, reserves characters, stores the chunks and queues chunk 0.
// handleJob      one queue message = one TTS call; each chunk queues the next, the last queues "assemble".
// assemble       streams the stored parts into audio/<id>.mp3 without holding them all in memory.
//
// Every Worker run makes at most one TTS call, which keeps it inside the free plan's per-run limits.

import { splitText } from './chunk';
import {
  getEpisode,
  insertEpisode,
  markDone,
  markFailed,
  markProcessing,
  recordChunk,
} from './db';
import type { Env, JobMessage } from './env';
import { detectLang } from './lang';
import { mp3DurationMs, stripTags } from './mp3';
import { synthesize, TtsError } from './tts';
import type { Episode } from './types';
import { reserveChars } from './usage';

// Must match max_retries in wrangler.jsonc: the first try plus 3 retries.
export const MAX_ATTEMPTS = 4;
// Keeps the assemble run well under the free plan's 50 outbound calls (one R2 read per part).
export const MAX_CHUNKS = 40;

const chunksKey = (id: string) => `chunks/${id}.json`;
const partKey = (id: string, index: number) => `parts/${id}/${index}.mp3`;
const audioKey = (id: string) => `audio/${id}.mp3`;

export type CreateResult =
  | { ok: true; episode: Episode }
  | { ok: false; reason: 'empty' | 'too_long' | 'limit'; message: string; remaining?: number };

function defaultTitle(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const t = firstLine.trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

export async function createEpisode(
  env: Env,
  input: { text: string; title?: string; sourceUrl?: string },
  now = new Date(),
): Promise<CreateResult> {
  const lang = detectLang(input.text);
  const chunks = splitText(input.text, lang === 'ja-JP' ? 'ja' : 'en');
  // Google counts every character it receives, so count exactly what will be sent.
  const charCount = chunks.reduce((n, c) => n + c.length, 0);

  if (charCount === 0) return { ok: false, reason: 'empty', message: '本文が空です。' };
  const maxChars = Number(env.MAX_CHARS_PER_EPISODE);
  if (charCount > maxChars || chunks.length > MAX_CHUNKS) {
    return {
      ok: false,
      reason: 'too_long',
      message: `1本あたりの上限（${maxChars.toLocaleString()}字）を超えています（${charCount.toLocaleString()}字）。`,
    };
  }

  const reserved = await reserveChars(env.DB, charCount, Number(env.MONTHLY_CHAR_LIMIT), now);
  if (!reserved.ok) {
    return {
      ok: false,
      reason: 'limit',
      remaining: reserved.remaining,
      message: `今月の上限に達するため変換できません。残り${reserved.remaining.toLocaleString()}字です。`,
    };
  }

  const id = crypto.randomUUID();
  const episode = {
    id,
    title: input.title?.trim() || defaultTitle(chunks[0]),
    lang,
    char_count: charCount,
    total_chunks: chunks.length,
    source_url: input.sourceUrl ?? null,
    created_at: now.toISOString(),
  };
  await env.BUCKET.put(chunksKey(id), JSON.stringify(chunks));
  await insertEpisode(env.DB, episode);
  await env.QUEUE.send({ episodeId: id, index: 0 });
  return { ok: true, episode: (await getEpisode(env.DB, id))! };
}

// Restarts a failed episode from the first unfinished chunk.
export async function retryEpisode(env: Env, id: string, now = new Date()): Promise<CreateResult | null> {
  const ep = await getEpisode(env.DB, id);
  if (!ep || ep.status !== 'failed') return null;

  if (ep.done_chunks < ep.total_chunks) {
    // The failed chunk will be sent again, and Google charges again, so reserve it again.
    const chunk = await loadChunk(env, id, ep.done_chunks);
    const reserved = await reserveChars(env.DB, chunk.length, Number(env.MONTHLY_CHAR_LIMIT), now);
    if (!reserved.ok) {
      return {
        ok: false,
        reason: 'limit',
        remaining: reserved.remaining,
        message: `今月の上限に達するため再実行できません。残り${reserved.remaining.toLocaleString()}字です。`,
      };
    }
  }

  await markProcessing(env.DB, id);
  await env.QUEUE.send(
    ep.done_chunks < ep.total_chunks ? { episodeId: id, index: ep.done_chunks } : { episodeId: id, assemble: true },
  );
  return { ok: true, episode: (await getEpisode(env.DB, id))! };
}

async function loadChunk(env: Env, id: string, index: number): Promise<string> {
  const obj = await env.BUCKET.get(chunksKey(id));
  if (!obj) throw new Error('chunks file is missing');
  const chunks = (await obj.json()) as string[];
  return chunks[index];
}

async function processChunk(env: Env, ep: Episode, index: number, attempts: number, now: Date): Promise<void> {
  // A redelivered message may find this chunk already done; just move on.
  if (index < ep.done_chunks) return;

  const key = partKey(ep.id, index);
  let part = await env.BUCKET.head(key);
  if (!part) {
    const text = await loadChunk(env, ep.id, index);
    if (attempts > 1) {
      // This is a resend, which Google charges again.
      const reserved = await reserveChars(env.DB, text.length, Number(env.MONTHLY_CHAR_LIMIT), now);
      if (!reserved.ok) throw new LimitReached();
    }
    const audio = stripTags(await synthesize(text, ep.lang, env));
    if (audio.length === 0) throw new TtsError('TTS returned no audio frames', 502, true);
    part = await env.BUCKET.put(key, audio, { customMetadata: { ms: String(mp3DurationMs(audio)) } });
  }
  await recordChunk(env.DB, ep.id, index, part.size, Number(part.customMetadata?.ms ?? 0));

  const next: JobMessage =
    index + 1 < ep.total_chunks ? { episodeId: ep.id, index: index + 1 } : { episodeId: ep.id, assemble: true };
  await env.QUEUE.send(next);
}

async function assemble(env: Env, ep: Episode): Promise<void> {
  const total = ep.audio_bytes ?? 0;
  const stream = new FixedLengthStream(total);
  const upload = env.BUCKET.put(audioKey(ep.id), stream.readable, {
    httpMetadata: { contentType: 'audio/mpeg' },
  });
  const writer = stream.writable.getWriter();
  try {
    for (let i = 0; i < ep.total_chunks; i++) {
      const part = await env.BUCKET.get(partKey(ep.id, i));
      if (!part) throw new Error(`part ${i} is missing`);
      await writer.write(new Uint8Array(await part.arrayBuffer()));
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
    await upload.catch(() => {});
    throw err;
  }
  await upload;

  await markDone(env.DB, ep.id, audioKey(ep.id), Math.round(ep.audio_ms / 1000));
  const parts = Array.from({ length: ep.total_chunks }, (_, i) => partKey(ep.id, i));
  await env.BUCKET.delete([...parts, chunksKey(ep.id)]);
}

class LimitReached extends Error {}

function failureMessage(err: unknown): string {
  if (err instanceof LimitReached) return '今月の文字数の上限に達したため停止しました。';
  if (err instanceof TtsError) return `音声AIのエラー（${err.status}）: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function handleJob(env: Env, msg: Message<JobMessage>, now = new Date()): Promise<void> {
  const job = msg.body;
  const ep = await getEpisode(env.DB, job.episodeId);
  if (!ep || ep.status !== 'processing') {
    msg.ack(); // deleted, already finished, or already marked failed
    return;
  }

  try {
    if ('assemble' in job) await assemble(env, ep);
    else await processChunk(env, ep, job.index, msg.attempts, now);
    msg.ack();
  } catch (err) {
    const permanent =
      err instanceof LimitReached || (err instanceof TtsError && !err.retryable) || msg.attempts >= MAX_ATTEMPTS;
    if (permanent) {
      await markFailed(env.DB, ep.id, failureMessage(err));
      msg.ack();
    } else {
      msg.retry();
    }
  }
}
