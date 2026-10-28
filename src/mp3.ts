// Joins the MP3 pieces returned by Google TTS into one file and measures its length.
// Each piece may start with an ID3 tag or a Xing/Info frame that states the length of that piece only.
// Players trust the first one they see, so both are removed before joining.

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

interface Frame {
  length: number;
  samples: number;
  sampleRate: number;
  sideInfoEnd: number; // offset from frame start where a Xing/Info tag would sit
}

// Reads a Layer III frame header at offset i, or returns null if there is none.
function readFrame(b: Uint8Array, i: number): Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3;
  const layer = (b[i + 1] >> 1) & 3;
  const bitrateIdx = b[i + 2] >> 4;
  const rateIdx = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;

  const v1 = version === 3;
  const bitrate = (v1 ? BITRATES_V1 : BITRATES_V2)[bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIdx];
  const padding = (b[i + 2] >> 1) & 1;
  const mono = b[i + 3] >> 6 === 3;
  return {
    length: Math.floor(((v1 ? 144 : 72) * bitrate) / sampleRate) + padding,
    samples: v1 ? 1152 : 576,
    sampleRate,
    sideInfoEnd: 4 + (v1 ? (mono ? 17 : 32) : mono ? 9 : 17),
  };
}

function id3v2Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // "ID3"
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function hasTagAt(b: Uint8Array, i: number, tags: string[]): boolean {
  return tags.some((t) => [...t].every((c, k) => b[i + k] === c.charCodeAt(0)));
}

function firstFrameOffset(b: Uint8Array, start: number): number {
  for (let i = start; i + 4 <= b.length; i++) {
    const f = readFrame(b, i);
    // Require the next frame to line up too, so stray 0xFF bytes are not mistaken for a header.
    if (f && (i + f.length >= b.length || readFrame(b, i + f.length))) return i;
  }
  return -1;
}

// Returns only the audio frames: no ID3v2 header, no ID3v1 trailer, no Xing/Info/VBRI frame.
export function stripTags(input: Uint8Array): Uint8Array {
  let end = input.length;
  if (end >= 128 && hasTagAt(input, end - 128, ['TAG'])) end -= 128;
  const b = input.subarray(0, end);

  let start = firstFrameOffset(b, id3v2Size(b));
  if (start < 0) return new Uint8Array(0);

  const f = readFrame(b, start)!;
  if (hasTagAt(b, start + f.sideInfoEnd, ['Xing', 'Info']) || hasTagAt(b, start + 36, ['VBRI'])) {
    start += f.length;
  }
  return b.subarray(start);
}

export function concatMp3(parts: Uint8Array[]): Uint8Array {
  const frames = parts.map(stripTags);
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

// Adds up every frame, so the result is right for both constant and variable bitrate files.
export function mp3DurationSec(b: Uint8Array): number {
  let i = firstFrameOffset(b, id3v2Size(b));
  if (i < 0) return 0;
  let seconds = 0;
  for (let f = readFrame(b, i); f; f = readFrame(b, i)) {
    seconds += f.samples / f.sampleRate;
    i += f.length;
  }
  return Math.round(seconds);
}
