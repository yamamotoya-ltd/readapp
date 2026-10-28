// Splits text into pieces small enough for one Google TTS request.
// The API rejects inputs over 5,000 bytes, so we stay well under with a default of 4,500.

const encoder = new TextEncoder();
const byteLen = (s: string) => encoder.encode(s).length;

export const DEFAULT_MAX_BYTES = 4500;

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sentences(paragraph: string, lang: string): string[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  return Array.from(seg.segment(paragraph), (s) => s.segment).filter((s) => s.trim() !== '');
}

// Hard-split a string by code points so each part fits maxBytes.
function splitByBytes(s: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (byteLen(cur + ch) > maxBytes) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Break an oversized sentence at commas or spaces first, then by bytes as a last resort.
function splitLongSentence(s: string, maxBytes: number): string[] {
  const pieces = s.split(/(?<=[、，,]|\s)/);
  const out: string[] = [];
  for (const p of pieces) {
    if (byteLen(p) <= maxBytes) out.push(p);
    else out.push(...splitByBytes(p, maxBytes));
  }
  return pack(out, maxBytes, '');
}

// Greedily join pieces with sep while staying within maxBytes.
function pack(pieces: string[], maxBytes: number, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    const next = cur === '' ? p : cur + sep + p;
    if (byteLen(next) <= maxBytes) {
      cur = next;
    } else {
      if (cur !== '') out.push(cur);
      cur = p;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

export function splitText(text: string, lang = 'ja', maxBytes = DEFAULT_MAX_BYTES): string[] {
  const normalized = normalizeText(text);
  if (normalized === '') return [];

  const units: string[] = [];
  for (const para of normalized.split(/\n{2,}/)) {
    const paraUnits: string[] = [];
    for (const sentence of sentences(para, lang)) {
      if (byteLen(sentence) <= maxBytes) paraUnits.push(sentence);
      else paraUnits.push(...splitLongSentence(sentence, maxBytes));
    }
    // Keep sentences of one paragraph together, then mark the paragraph end with a newline
    // so the TTS voice pauses naturally between paragraphs.
    units.push(...pack(paraUnits, maxBytes, '').map((u) => u.trim()).filter((u) => u !== ''));
  }
  return pack(units, maxBytes, '\n');
}
