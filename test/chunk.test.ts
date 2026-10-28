import { describe, expect, it } from 'vitest';
import { normalizeText, splitText } from '../src/chunk';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const noSpace = (s: string) => s.replace(/\s+/g, '');

describe('splitText', () => {
  it('returns nothing for blank input', () => {
    expect(splitText('  \n\n ')).toEqual([]);
  });

  it('keeps a short text as one chunk', () => {
    expect(splitText('こんにちは。今日は晴れです。')).toEqual(['こんにちは。今日は晴れです。']);
  });

  it('splits long Japanese text at sentence ends within the byte limit', () => {
    const sentence = 'これは中禅寺湖のSUPについての文章です。';
    const text = sentence.repeat(300);
    const chunks = splitText(text, 'ja', 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(1000);
      expect(c.endsWith('。')).toBe(true);
    }
    expect(noSpace(chunks.join(''))).toBe(noSpace(text));
  });

  it('splits English text at sentence ends', () => {
    const text = 'The lake is calm today. We paddle at sunrise! '.repeat(100);
    const chunks = splitText(text, 'en', 500);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(500);
      expect(/[.!]$/.test(c)).toBe(true);
    }
    expect(noSpace(chunks.join(''))).toBe(noSpace(text));
  });

  it('still respects the limit when a sentence has no punctuation at all', () => {
    const text = 'あ'.repeat(5000);
    const chunks = splitText(text, 'ja', 4500);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(4500);
    expect(chunks.join('')).toBe(text);
  });

  it('breaks an oversized sentence at commas before cutting mid-word', () => {
    const text = '日光の山道は、'.repeat(200) + '終わり。';
    const chunks = splitText(text, 'ja', 600);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('、')).toBe(true);
    expect(noSpace(chunks.join(''))).toBe(noSpace(text));
  });

  it('does not split surrogate pairs', () => {
    const text = '😀'.repeat(2000);
    const chunks = splitText(text, 'ja', 4500);
    for (const c of chunks) expect(c).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(chunks.join('')).toBe(text);
  });

  it('separates paragraphs with a newline', () => {
    expect(splitText('一段落目。\n\n二段落目。')).toEqual(['一段落目。\n二段落目。']);
  });
});

describe('normalizeText', () => {
  it('collapses spaces and extra blank lines', () => {
    expect(normalizeText('a  b\r\n\r\n\r\n　c ')).toBe('a b\n\nc');
  });
});
