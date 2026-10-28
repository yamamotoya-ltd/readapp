import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEpisode } from '../src/db';
import type { Env, JobMessage } from '../src/env';
import { mp3DurationSec } from '../src/mp3';
import { createEpisode, handleJob, retryEpisode } from '../src/pipeline';
import { usedChars } from '../src/usage';

// 1000 MPEG-2 Layer III frames = 24 s of audio per TTS call.
function fakeMp3(frames = 1000): Uint8Array {
  const out = new Uint8Array(frames * 96);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xf3, 0x44, 0xc0], i * 96);
  return out;
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const ttsOk = () => Response.json({ audioContent: b64(fakeMp3()) });

// A queue we drive by hand, so each message runs exactly when the test says.
function makeEnv() {
  const sent: JobMessage[] = [];
  const queue = { send: async (m: JobMessage) => void sent.push(m) } as unknown as Queue<JobMessage>;
  const testEnv: Env = { ...env, QUEUE: queue, GOOGLE_TTS_API_KEY: 'test-key', MONTHLY_CHAR_LIMIT: '900000' };
  return { testEnv, sent };
}

function message(body: JobMessage, attempts = 1) {
  const m = { body, attempts, acked: false, retried: false } as {
    body: JobMessage; attempts: number; acked: boolean; retried: boolean; ack(): void; retry(): void;
  };
  m.ack = () => void (m.acked = true);
  m.retry = () => void (m.retried = true);
  return m;
}

// Runs queued messages until none are left. Returns how many TTS calls happened.
async function drain(testEnv: Env, sent: JobMessage[]) {
  while (sent.length) {
    const m = message(sent.shift()!);
    await handleJob(testEnv, m as unknown as Message<JobMessage>);
    expect(m.acked).toBe(true);
  }
}

// About 21,000 bytes: several chunks at the default 4,500-byte limit.
const longText = 'これは日光の中禅寺湖でSUPを楽しむための記事の一文です。'.repeat(250);

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await env.DB.exec('DELETE FROM episodes; DELETE FROM usage;');
  fetchMock = vi.spyOn(globalThis, 'fetch');
});
afterEach(async () => {
  fetchMock.mockRestore();
  const listed = await env.BUCKET.list();
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
});

describe('pipeline', () => {
  it('turns text into one finished episode and cleans up the parts', async () => {
    fetchMock.mockImplementation(async () => ttsOk());
    const { testEnv, sent } = makeEnv();

    const res = await createEpisode(testEnv, { text: longText });
    if (!res.ok) throw new Error(res.message);
    const ep = res.episode;
    const n = ep.total_chunks;
    expect(n).toBeGreaterThan(1);
    expect(ep.status).toBe('processing');
    expect(await usedChars(env.DB, new Date())).toBe(ep.char_count);

    await drain(testEnv, sent);

    const done = (await getEpisode(env.DB, ep.id))!;
    expect(done.status).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(n);
    const audio = await env.BUCKET.get(done.audio_key!);
    const bytes = new Uint8Array(await audio!.arrayBuffer());
    expect(bytes.length).toBe(n * 1000 * 96);
    expect(done.audio_bytes).toBe(bytes.length);
    expect(done.duration_sec).toBe(n * 24);
    expect(mp3DurationSec(bytes)).toBe(n * 24);
    const left = await env.BUCKET.list();
    expect(left.objects.map((o) => o.key)).toEqual([done.audio_key]);
  });

  it('marks the episode failed after the last retry, and retry finishes it', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => (++calls === 2 ? new Response('busy', { status: 503 }) : ttsOk()));
    const { testEnv, sent } = makeEnv();
    const res = await createEpisode(testEnv, { text: longText });
    if (!res.ok) throw new Error(res.message);
    const id = res.episode.id;

    await handleJob(testEnv, message(sent.shift()!) as unknown as Message<JobMessage>); // chunk 0 ok
    const job = sent.shift()!; // chunk 1: fails every time while the mock says so
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    const first = message(job, 1);
    await handleJob(testEnv, first as unknown as Message<JobMessage>);
    expect(first.retried).toBe(true);
    const last = message(job, 4);
    await handleJob(testEnv, last as unknown as Message<JobMessage>);
    expect(last.acked).toBe(true);

    const failed = (await getEpisode(env.DB, id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('503');
    expect(failed.done_chunks).toBe(1);

    const before = await usedChars(env.DB, new Date());
    fetchMock.mockImplementation(async () => ttsOk());
    const retried = await retryEpisode(testEnv, id);
    expect(retried?.ok).toBe(true);
    // The resent chunk is counted again.
    expect(await usedChars(env.DB, new Date())).toBeGreaterThan(before);
    await drain(testEnv, sent);
    expect((await getEpisode(env.DB, id))!.status).toBe('done');
  });

  it('fails at once on a non-retryable error such as a bad API key', async () => {
    fetchMock.mockImplementation(async () => new Response('bad key', { status: 403 }));
    const { testEnv, sent } = makeEnv();
    const res = await createEpisode(testEnv, { text: '短い記事です。' });
    if (!res.ok) throw new Error(res.message);
    const m = message(sent.shift()!);
    await handleJob(testEnv, m as unknown as Message<JobMessage>);
    expect(m.acked).toBe(true);
    expect((await getEpisode(env.DB, res.episode.id))!.status).toBe('failed');
  });

  it('counts each resend against the monthly limit', async () => {
    fetchMock.mockImplementation(async () => ttsOk());
    const { testEnv, sent } = makeEnv();
    const res = await createEpisode(testEnv, { text: '短い記事です。' });
    if (!res.ok) throw new Error(res.message);
    const before = await usedChars(env.DB, new Date());
    await handleJob(testEnv, message(sent.shift()!, 2) as unknown as Message<JobMessage>);
    expect(await usedChars(env.DB, new Date())).toBe(before + res.episode.char_count);
  });

  it('does not call TTS twice when a finished chunk is delivered again', async () => {
    fetchMock.mockImplementation(async () => ttsOk());
    const { testEnv, sent } = makeEnv();
    const res = await createEpisode(testEnv, { text: longText });
    if (!res.ok) throw new Error(res.message);
    const job = sent.shift()!;
    await handleJob(testEnv, message(job) as unknown as Message<JobMessage>);
    await handleJob(testEnv, message(job) as unknown as Message<JobMessage>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getEpisode(env.DB, res.episode.id))!.done_chunks).toBe(1);
  });

  it('refuses before calling TTS when the month would go over the limit', async () => {
    const { testEnv, sent } = makeEnv();
    testEnv.MONTHLY_CHAR_LIMIT = '10';
    const res = await createEpisode(testEnv, { text: 'この文章は十文字を超えています。' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('limit');
    expect(sent).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses empty and oversized text', async () => {
    const { testEnv } = makeEnv();
    expect(await createEpisode(testEnv, { text: '   ' })).toMatchObject({ ok: false, reason: 'empty' });
    expect(await createEpisode(testEnv, { text: 'あ'.repeat(50001) })).toMatchObject({ ok: false, reason: 'too_long' });
    expect(await usedChars(env.DB, new Date())).toBe(0);
  });
});
