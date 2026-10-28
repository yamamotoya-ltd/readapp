import { describe, it, expect } from 'vitest';
import { detectLang } from '../src/lang';

describe('detectLang', () => {
  it('returns ja-JP for pure Japanese text', () => {
    expect(detectLang('これは日本語のテキストです。')).toBe('ja-JP');
  });

  it('returns en-US for pure English text', () => {
    expect(detectLang('This is a plain English sentence.')).toBe('en-US');
  });

  it('returns ja-JP for a Japanese article with many English words', () => {
    expect(
      detectLang('Claude CodeでCloudflare Workersを使ってAPIを作る方法を紹介します。'),
    ).toBe('ja-JP');
  });

  it('returns en-US for English text containing one Japanese word', () => {
    expect(
      detectLang('This article discusses the word 日本 and many other English terms in detail.'),
    ).toBe('en-US');
  });

  it('returns ja-JP for empty string', () => {
    expect(detectLang('')).toBe('ja-JP');
  });
});
