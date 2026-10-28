import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { serveAudio } from '../src/audio';

const KEY = 'episodes/test.mp3';
const SIZE = 1000;
const data = new Uint8Array(SIZE).map((_, i) => i % 256);

const req = (method: string, range?: string) =>
  new Request('https://example.test/audio/test.mp3', {
    method,
    headers: range ? { Range: range } : {},
  });

async function clearBucket() {
  const list = await env.BUCKET.list();
  if (list.objects.length > 0) await env.BUCKET.delete(list.objects.map((o) => o.key));
}

beforeEach(async () => {
  await clearBucket();
  await env.BUCKET.put(KEY, data);
});

afterEach(clearBucket);

describe('serveAudio', () => {
  it('returns the full object with 200 when no Range is sent', async () => {
    const res = await serveAudio(req('GET'), env.BUCKET, KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Content-Length')).toBe(String(SIZE));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it('returns the same headers with a null body for HEAD', async () => {
    const res = await serveAudio(req('HEAD'), env.BUCKET, KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Content-Length')).toBe(String(SIZE));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.body).toBeNull();
  });

  it('serves bytes=0-99 as 206 with 100 bytes', async () => {
    const res = await serveAudio(req('GET', 'bytes=0-99'), env.BUCKET, KEY);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.subarray(0, 100));
  });

  it('serves bytes=900- as 206 with the tail of the object', async () => {
    const res = await serveAudio(req('GET', 'bytes=900-'), env.BUCKET, KEY);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 900-999/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.subarray(900));
  });

  it('serves bytes=-100 as 206 with the last 100 bytes', async () => {
    const res = await serveAudio(req('GET', 'bytes=-100'), env.BUCKET, KEY);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 900-999/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.subarray(900));
  });

  it('clamps an end past the object size', async () => {
    const res = await serveAudio(req('GET', 'bytes=990-5000'), env.BUCKET, KEY);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 990-999/1000');
    expect(res.headers.get('Content-Length')).toBe('10');
  });

  it('returns 416 with bytes */total when the start is past the end', async () => {
    const res = await serveAudio(req('GET', 'bytes=5000-'), env.BUCKET, KEY);
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */1000');
  });

  it('returns 416 for a malformed range', async () => {
    const res = await serveAudio(req('GET', 'bytes=abc'), env.BUCKET, KEY);
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */1000');
  });

  it('ignores a multi-range request and returns the full object with 200', async () => {
    const res = await serveAudio(req('GET', 'bytes=0-9,20-29'), env.BUCKET, KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Range')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it('serves a range on HEAD with headers only', async () => {
    const res = await serveAudio(req('HEAD', 'bytes=0-99'), env.BUCKET, KEY);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(res.body).toBeNull();
  });

  it('returns 404 when the key is missing', async () => {
    const res = await serveAudio(req('GET'), env.BUCKET, 'episodes/missing.mp3');
    expect(res.status).toBe(404);
  });

  it('returns 405 for other methods', async () => {
    const res = await serveAudio(req('POST'), env.BUCKET, KEY);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
  });
});
