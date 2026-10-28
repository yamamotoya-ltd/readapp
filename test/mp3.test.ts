import { describe, expect, it } from 'vitest';
import { concatMp3, mp3DurationSec, stripTags } from '../src/mp3';

// MPEG-2 Layer III, 32 kbps, 24 kHz, mono: 96 bytes and 576 samples (0.024 s) per frame.
const FRAME_LEN = 96;
function frame(fill = 0x11): Uint8Array {
  const f = new Uint8Array(FRAME_LEN).fill(fill);
  f.set([0xff, 0xf3, 0x44, 0xc0]);
  return f;
}
function xingFrame(tag = 'Xing'): Uint8Array {
  const f = frame(0);
  f.set([...tag].map((c) => c.charCodeAt(0)), 4 + 9); // after mono MPEG-2 side info
  return f;
}
const id3v2 = () => new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]); // 5-byte body
const id3v1 = () => {
  const t = new Uint8Array(128);
  t.set([0x54, 0x41, 0x47]); // "TAG"
  return t;
};
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const frames = (n: number) => join(...Array.from({ length: n }, () => frame()));
const contains = (b: Uint8Array, s: string) => new TextDecoder('latin1').decode(b).includes(s);

describe('mp3DurationSec', () => {
  it('adds up frame durations', () => {
    expect(mp3DurationSec(frames(1000))).toBe(24);
  });

  it('skips a leading ID3 tag', () => {
    expect(mp3DurationSec(join(id3v2(), frames(1000)))).toBe(24);
  });

  it('returns 0 for data that is not MP3', () => {
    expect(mp3DurationSec(new Uint8Array(500).fill(7))).toBe(0);
  });
});

describe('stripTags', () => {
  it('removes ID3v2, a Xing frame and ID3v1', () => {
    const out = stripTags(join(id3v2(), xingFrame(), frames(10), id3v1()));
    expect(out).toEqual(frames(10));
  });

  it('removes an Info frame', () => {
    expect(stripTags(join(xingFrame('Info'), frames(3)))).toEqual(frames(3));
  });

  it('leaves plain audio untouched', () => {
    expect(stripTags(frames(5))).toEqual(frames(5));
  });
});

describe('concatMp3', () => {
  it('joins pieces so the total length is the sum and no per-piece header survives', () => {
    const piece = (n: number) => join(id3v2(), xingFrame(), frames(n));
    const out = concatMp3([piece(500), piece(250), piece(250)]);
    expect(out.length).toBe(1000 * FRAME_LEN);
    expect(mp3DurationSec(out)).toBe(24);
    expect(contains(out, 'Xing')).toBe(false);
    expect(contains(out, 'ID3')).toBe(false);
  });
});
