import { serveAudio } from './audio';
import { verifyAccess, type AccessVerifier } from './auth';
import { getEpisode, getFeedToken, listEpisodes, rotateFeedToken } from './db';
import type { Env } from './env';
import { buildRss } from './feed';
import { createEpisode, retryEpisode, type CreateResult } from './pipeline';
import { uiHtml } from './ui';
import { remainingChars } from './usage';

const ID = '[A-Za-z0-9-]+';
const FEED_RE = new RegExp(`^/feed/(${ID})\\.xml$`);
const AUDIO_RE = new RegExp(`^/audio/(${ID})/(${ID})\\.mp3$`);
const RETRY_RE = new RegExp(`^/api/episodes/(${ID})/retry$`);

const notFoundText = () => new Response('Not Found', { status: 404 });
const json = (body: unknown, status = 200) => Response.json(body, { status });

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function tokenOk(env: Env, given: string): Promise<boolean> {
  return safeEqual(given, await getFeedToken(env.DB));
}

function failure(r: Extract<CreateResult, { ok: false }>): Response {
  const status = r.reason === 'limit' ? 429 : 400;
  return json({ error: r.message, reason: r.reason, remaining: r.remaining ?? null }, status);
}

async function publicRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const isRead = request.method === 'GET' || request.method === 'HEAD';

  if (request.method === 'GET' && pathname === '/healthz') return new Response('ok', { status: 200 });

  const feed = FEED_RE.exec(pathname);
  if (feed && isRead) {
    if (!(await tokenOk(env, feed[1]))) return notFoundText();
    const body = buildRss(await listEpisodes(env.DB), url.origin, feed[1]);
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'private, max-age=300',
      },
    });
  }

  const audio = AUDIO_RE.exec(pathname);
  if (audio && isRead) {
    if (!(await tokenOk(env, audio[1]))) return notFoundText();
    const ep = await getEpisode(env.DB, audio[2]);
    if (!ep || ep.status !== 'done' || !ep.audio_key) return notFoundText();
    return serveAudio(request, env.BUCKET, ep.audio_key);
  }
  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function route(
  request: Request,
  env: Env,
  verify: AccessVerifier = verifyAccess,
): Promise<Response> {
  const url = new URL(request.url);

  const pub = await publicRoute(request, env, url);
  if (pub) return pub;

  if (!(await verify(request, env))) return json({ error: 'unauthorized' }, 401);

  const { pathname } = url;
  const method = request.method;

  if (method === 'POST') {
    const contentType = request.headers.get('Content-Type') ?? '';
    if (request.headers.get('Origin') !== url.origin || !contentType.toLowerCase().startsWith('application/json')) {
      return json({ error: 'forbidden' }, 403);
    }
  }

  const feedUrl = async () => `${url.origin}/feed/${await getFeedToken(env.DB)}.xml`;

  if (method === 'GET' && pathname === '/') {
    return new Response(uiHtml(), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (method === 'GET' && pathname === '/api/state') {
    const monthlyLimit = Number(env.MONTHLY_CHAR_LIMIT);
    return json({
      episodes: await listEpisodes(env.DB),
      remaining: await remainingChars(env.DB, monthlyLimit, new Date()),
      monthlyLimit,
      maxCharsPerEpisode: Number(env.MAX_CHARS_PER_EPISODE),
      feedUrl: await feedUrl(),
    });
  }

  if (method === 'POST' && pathname === '/api/episodes') {
    const body = await readBody(request);
    if (!body || typeof body.text !== 'string') return json({ error: '本文を送信してください。', reason: 'bad_request' }, 400);
    const title = typeof body.title === 'string' ? body.title : undefined;
    const result = await createEpisode(env, { text: body.text, title });
    return result.ok ? json({ episode: result.episode }, 202) : failure(result);
  }

  const retry = RETRY_RE.exec(pathname);
  if (method === 'POST' && retry) {
    const result = await retryEpisode(env, retry[1]);
    if (!result) return json({ error: 'not found' }, 404);
    return result.ok ? json({ episode: result.episode }, 202) : failure(result);
  }

  if (method === 'POST' && pathname === '/api/feed-token/rotate') {
    await rotateFeedToken(env.DB);
    return json({ feedUrl: await feedUrl() });
  }

  return json({ error: 'not found' }, 404);
}
