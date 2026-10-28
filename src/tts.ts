import type { Lang } from './types';
import type { Env } from './env';

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const MAX_ERROR_BODY_CHARS = 200;

export class TtsError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
    this.retryable = retryable;
  }
}

// status 0 means the request never got a response (network failure).
function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export async function synthesize(
  text: string,
  lang: Lang,
  env: Pick<Env, 'GOOGLE_TTS_API_KEY' | 'TTS_VOICE_JA' | 'TTS_VOICE_EN'>,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  // The key goes in a header, not the URL, so it never appears in logs or error URLs.
  let res: Response;
  try {
    res = await fetchFn(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_TTS_API_KEY,
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: lang,
          name: lang === 'ja-JP' ? env.TTS_VOICE_JA : env.TTS_VOICE_EN,
        },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TtsError(`TTS network error: ${reason}`, 0, true);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TtsError(
      `TTS request failed with status ${res.status}: ${body.slice(0, MAX_ERROR_BODY_CHARS)}`,
      res.status,
      isRetryable(res.status),
    );
  }

  const json = (await res.json()) as { audioContent?: unknown };
  if (typeof json.audioContent !== 'string' || json.audioContent === '') {
    throw new TtsError('TTS response is missing audioContent', 502, true);
  }

  let binary: string;
  try {
    binary = atob(json.audioContent);
  } catch {
    throw new TtsError('TTS response audioContent is not valid base64', 502, true);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
