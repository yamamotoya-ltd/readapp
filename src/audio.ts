// Streams an R2 audio object over HTTP with Range support.
// Apple Podcasts requires byte ranges, so every response advertises Accept-Ranges.
// Token checking is the caller's job; this only serves the bytes.

const CONTENT_TYPE = 'audio/mpeg';
const CACHE_CONTROL = 'private, max-age=3600';

type ParsedRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

// Parses a Range header against the object size.
// - No header, or multiple ranges (comma), -> full response.
// - Malformed or unsatisfiable single range -> unsatisfiable (416).
function parseRange(header: string | null, size: number): ParsedRange {
  if (header === null) return { kind: 'full' };

  const value = header.trim();
  if (!value.toLowerCase().startsWith('bytes=')) return { kind: 'unsatisfiable' };

  const spec = value.slice('bytes='.length).trim();
  if (spec.includes(',')) return { kind: 'full' };

  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'unsatisfiable' };

  if (m[1] === '') {
    // Suffix range: last N bytes.
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(m[1]);
  if (start >= size) return { kind: 'unsatisfiable' };

  if (m[2] === '') return { kind: 'partial', start, end: size - 1 };

  const end = Number(m[2]);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

export async function serveAudio(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const head = await bucket.head(key);
  if (!head) return new Response('Not Found', { status: 404 });

  const size = head.size;
  const isHead = request.method === 'HEAD';
  const range = parseRange(request.headers.get('Range'), size);

  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
    });
  }

  if (range.kind === 'full') {
    const headers = {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      ETag: head.httpEtag,
      'Cache-Control': CACHE_CONTROL,
    };
    if (isHead) return new Response(null, { status: 200, headers });

    const object = await bucket.get(key);
    if (!object) return new Response('Not Found', { status: 404 });
    return new Response(object.body, { status: 200, headers });
  }

  const { start, end } = range;
  const headers = {
    'Content-Type': CONTENT_TYPE,
    'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    ETag: head.httpEtag,
    'Cache-Control': CACHE_CONTROL,
  };
  if (isHead) return new Response(null, { status: 206, headers });

  const object = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
  if (!object) return new Response('Not Found', { status: 404 });
  return new Response(object.body, { status: 206, headers });
}
