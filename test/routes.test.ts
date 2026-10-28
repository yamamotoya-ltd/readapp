import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAccess, type AccessVerifier } from '../src/auth';
import { getFeedToken, insertEpisode, markDone, rotateFeedToken } from '../src/db';
import type { Env, JobMessage } from '../src/env';
import { route } from '../src/routes';

const ORIGIN = 'https://app.example.com';
const allow: AccessVerifier = async () => true;
const deny: AccessVerifier = async () => false;

function makeEnv(over: Partial<Env> = {}) {
  const sent: JobMessage[] = [];
  const queue = { send: async (m: JobMessage) => void sent.push(m) } as unknown as Queue<JobMessage>;
  const testEnv: Env = { ...env, QUEUE: queue, GOOGLE_TTS_API_KEY: 'test-key', MONTHLY_CHAR_LIMIT: '900000', ...over };
  return { testEnv, sent };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

async function seedDone(id: string, audioKey = `audio/${id}.mp3`) {
  await insertEpisode(env.DB, {
    id, title: 'done ep', lang: 'ja-JP', char_count: 10, total_chunks: 1, source_url: null,
    created_at: new Date().toISOString(),
  });
  await markDone(env.DB, id, audioKey, 42);
}

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await env.DB.exec('DELETE FROM episodes; DELETE FROM usage; DELETE FROM settings;');
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('no external calls allowed in tests');
  });
});
afterEach(async () => {
  fetchMock.mockRestore();
  const listed = await env.BUCKET.list();
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
});

describe('auth gate', () => {
  it('healthz is public', async () => {
    const { testEnv } = makeEnv();
    const res = await route(get('/healthz'), testEnv, deny);
    expect(res.status).toBe(200);
  });

  it('protected routes return 401 without auth', async () => {
    const { testEnv } = makeEnv();
    for (const req of [get('/'), get('/api/state'), post('/api/episodes', { text: 'x' }), get('/nope')]) {
      const res = await route(req, testEnv, deny);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('GET / serves html with CSP', async () => {
    const { testEnv } = makeEnv();
    const res = await route(get('/'), testEnv, allow);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(await res.text()).toContain('音声にする');
  });

  it('unknown path is 404 json when authed', async () => {
    const { testEnv } = makeEnv();
    const res = await route(get('/nope'), testEnv, allow);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('POST /api/episodes', () => {
  it('creates an episode', async () => {
    const { testEnv, sent } = makeEnv();
    const res = await route(post('/api/episodes', { text: 'こんにちは。テストです。', title: 'T' }), testEnv, allow);
    expect(res.status).toBe(202);
    const { episode } = (await res.json()) as { episode: { id: string; title: string } };
    expect(episode.title).toBe('T');
    const row = await env.DB.prepare('SELECT id FROM episodes WHERE id = ?').bind(episode.id).first();
    expect(row).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('rejects a missing Origin', async () => {
    const { testEnv } = makeEnv();
    const req = new Request(`${ORIGIN}/api/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a' }),
    });
    expect((await route(req, testEnv, allow)).status).toBe(403);
    const other = post('/api/episodes', { text: 'a' }, { Origin: 'https://evil.example' });
    expect((await route(other, testEnv, allow)).status).toBe(403);
  });

  it('rejects a wrong Content-Type', async () => {
    const { testEnv } = makeEnv();
    const res = await route(post('/api/episodes', { text: 'a' }, { 'Content-Type': 'text/plain' }), testEnv, allow);
    expect(res.status).toBe(403);
  });

  it('rejects invalid JSON, non-string text and empty text with 400', async () => {
    const { testEnv } = makeEnv();
    expect((await route(post('/api/episodes', '{nope'), testEnv, allow)).status).toBe(400);
    expect((await route(post('/api/episodes', { text: 5 }), testEnv, allow)).status).toBe(400);
    const res = await route(post('/api/episodes', { text: '   ' }), testEnv, allow);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe('empty');
  });

  it('returns 429 over the monthly limit', async () => {
    const { testEnv } = makeEnv({ MONTHLY_CHAR_LIMIT: '5' });
    const res = await route(post('/api/episodes', { text: 'これは五文字を超える本文です。' }), testEnv, allow);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { reason: string; remaining: number; error: string };
    expect(body.reason).toBe('limit');
    expect(body.remaining).toBe(5);
    expect(body.error).toBeTruthy();
  });

  it('retry of an unknown episode is 404', async () => {
    const { testEnv } = makeEnv();
    expect((await route(post('/api/episodes/nope/retry', {}), testEnv, allow)).status).toBe(404);
  });
});

describe('GET /api/state', () => {
  it('returns the expected shape', async () => {
    const { testEnv } = makeEnv();
    await seedDone('ep-1');
    const res = await route(get('/api/state'), testEnv, allow);
    expect(res.status).toBe(200);
    const s = (await res.json()) as Record<string, unknown>;
    const token = await getFeedToken(env.DB);
    expect(Array.isArray(s.episodes)).toBe(true);
    expect((s.episodes as unknown[]).length).toBe(1);
    expect(s.remaining).toBe(900000);
    expect(s.monthlyLimit).toBe(900000);
    expect(s.maxCharsPerEpisode).toBe(Number(env.MAX_CHARS_PER_EPISODE));
    expect(s.feedUrl).toBe(`${ORIGIN}/feed/${token}.xml`);
  });
});

describe('feed', () => {
  it('404 on a wrong token, 200 rss on the right one', async () => {
    const { testEnv } = makeEnv();
    await seedDone('ep-1');
    const token = await getFeedToken(env.DB);
    expect((await route(get('/feed/wrong.xml'), testEnv, deny)).status).toBe(404);
    const res = await route(get(`/feed/${token}.xml`), testEnv, deny);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    const xml = await res.text();
    expect(xml).toContain('done ep');
    expect(xml).toContain(`/audio/${token}/ep-1.mp3`);
  });

  it('rotation invalidates the old token', async () => {
    const { testEnv } = makeEnv();
    const old = await getFeedToken(env.DB);
    const res = await route(post('/api/feed-token/rotate', {}), testEnv, allow);
    expect(res.status).toBe(200);
    const { feedUrl } = (await res.json()) as { feedUrl: string };
    expect(feedUrl).not.toContain(old);
    expect((await route(get(`/feed/${old}.xml`), testEnv, deny)).status).toBe(404);
    const fresh = await getFeedToken(env.DB);
    expect(feedUrl).toBe(`${ORIGIN}/feed/${fresh}.xml`);
    expect((await route(get(`/feed/${fresh}.xml`), testEnv, deny)).status).toBe(200);
    await rotateFeedToken(env.DB);
  });
});

describe('audio', () => {
  it('404 on a wrong token or a missing episode', async () => {
    const { testEnv } = makeEnv();
    await seedDone('ep-1');
    const token = await getFeedToken(env.DB);
    expect((await route(get('/audio/wrong/ep-1.mp3'), testEnv, deny)).status).toBe(404);
    expect((await route(get(`/audio/${token}/missing.mp3`), testEnv, deny)).status).toBe(404);
  });

  it('serves audio and honours Range', async () => {
    const { testEnv } = makeEnv();
    await seedDone('ep-1');
    await env.BUCKET.put('audio/ep-1.mp3', new Uint8Array(1000).fill(7));
    const token = await getFeedToken(env.DB);

    const full = await route(get(`/audio/${token}/ep-1.mp3`), testEnv, deny);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('audio/mpeg');
    await full.arrayBuffer();

    const part = await route(get(`/audio/${token}/ep-1.mp3`, { Range: 'bytes=0-99' }), testEnv, deny);
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it('does not serve a processing episode', async () => {
    const { testEnv } = makeEnv();
    await insertEpisode(env.DB, {
      id: 'ep-p', title: 'p', lang: 'ja-JP', char_count: 1, total_chunks: 1, source_url: null,
      created_at: new Date().toISOString(),
    });
    const token = await getFeedToken(env.DB);
    expect((await route(get(`/audio/${token}/ep-p.mp3`), testEnv, deny)).status).toBe(404);
  });
});

describe('verifyAccess', () => {
  it('is false without the header', async () => {
    const { testEnv } = makeEnv({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' });
    expect(await verifyAccess(get('/'), testEnv)).toBe(false);
  });

  it('is false when the team domain or aud is unset', async () => {
    const req = get('/', { 'Cf-Access-Jwt-Assertion': 'a.b.c' });
    expect(await verifyAccess(req, makeEnv({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: 'aud' }).testEnv)).toBe(false);
    expect(await verifyAccess(req, makeEnv({ ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: '' }).testEnv)).toBe(false);
  });

  it('is false for a garbage token', async () => {
    const { testEnv } = makeEnv({ ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: 'aud' });
    expect(await verifyAccess(get('/', { 'Cf-Access-Jwt-Assertion': 'garbage' }), testEnv)).toBe(false);
  });
});
