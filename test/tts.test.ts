import { describe, expect, it, vi } from 'vitest';
import { synthesize, TtsError } from '../src/tts';

const ENV = {
  GOOGLE_TTS_API_KEY: 'test-key-123',
  TTS_VOICE_JA: 'ja-JP-Neural2-B',
  TTS_VOICE_EN: 'en-US-Neural2-C',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// base64 of bytes [0x00, 0x01, 0xfe, 0xff, 0x41]
const AUDIO_B64 = 'AAH+/0E=';
const AUDIO_BYTES = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x41]);

describe('synthesize request', () => {
  it('posts to the TTS endpoint with the key in a header only', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ audioContent: AUDIO_B64 }));

    await synthesize('こんにちは', 'ja-JP', ENV, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect(url).not.toContain('test-key-123');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Goog-Api-Key']).toBe('test-key-123');
    expect(JSON.stringify(init.body)).not.toContain('test-key-123');
  });

  it('sends the expected body shape and uses the Japanese voice for ja-JP', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ audioContent: AUDIO_B64 }));

    await synthesize('こんにちは', 'ja-JP', ENV, fetchFn);

    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      input: { text: 'こんにちは' },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
      audioConfig: { audioEncoding: 'MP3' },
    });
  });

  it('uses the English voice for en-US', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ audioContent: AUDIO_B64 }));

    await synthesize('Hello', 'en-US', ENV, fetchFn);

    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).voice).toEqual({
      languageCode: 'en-US',
      name: 'en-US-Neural2-C',
    });
  });
});

describe('synthesize response', () => {
  it('decodes audioContent base64 into the exact bytes', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ audioContent: AUDIO_B64 }));

    const out = await synthesize('Hello', 'en-US', ENV, fetchFn);

    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual(Array.from(AUDIO_BYTES));
  });

  it('throws a retryable 502 TtsError when audioContent is missing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));

    const err = await synthesize('Hello', 'en-US', ENV, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
  });

  it('throws a 502 TtsError when audioContent is empty', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ audioContent: '' }));

    await expect(synthesize('Hello', 'en-US', ENV, fetchFn)).rejects.toMatchObject({
      status: 502,
      retryable: true,
    });
  });
});

describe('synthesize errors', () => {
  it('marks 429 as retryable', async () => {
    const fetchFn = vi.fn(async () => new Response('quota exceeded', { status: 429 }));

    const err = await synthesize('Hello', 'en-US', ENV, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('quota exceeded');
  });

  it('marks 5xx as retryable', async () => {
    const fetchFn = vi.fn(async () => new Response('backend down', { status: 503 }));

    await expect(synthesize('Hello', 'en-US', ENV, fetchFn)).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it('marks 400 as not retryable', async () => {
    const fetchFn = vi.fn(async () => new Response('bad request', { status: 400 }));

    const err = await synthesize('Hello', 'en-US', ENV, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it('truncates the response body in the message to 200 characters', async () => {
    const fetchFn = vi.fn(async () => new Response('x'.repeat(500), { status: 400 }));

    const err = await synthesize('Hello', 'en-US', ENV, fetchFn).catch((e) => e);
    expect(err.message).toContain('x'.repeat(200));
    expect(err.message).not.toContain('x'.repeat(201));
  });

  it('never includes the API key in the error message', async () => {
    const fetchFn = vi.fn(async () => new Response('denied', { status: 403 }));

    const err = await synthesize('Hello', 'en-US', ENV, fetchFn).catch((e) => e);
    expect(err.message).not.toContain('test-key-123');
  });

  it('treats a thrown fetch as a retryable status 0 TtsError', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('network down');
    });

    const err = await synthesize('Hello', 'en-US', ENV, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
  });
});
