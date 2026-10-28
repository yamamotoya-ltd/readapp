import type { Lang } from './types';

// Japanese script characters: hiragana, katakana, CJK ideographs.
const JA_CHAR = /[぀-ゟ゠-ヿ一-鿿]/g;

// 20% threshold: English-heavy Japanese articles still read in Japanese.
const JA_RATIO_THRESHOLD = 0.2;

export function detectLang(text: string): Lang {
  const nonSpace = text.replace(/\s/g, '').length;
  if (nonSpace === 0) return 'ja-JP';
  const jaCount = (text.match(JA_CHAR) ?? []).length;
  return jaCount / nonSpace >= JA_RATIO_THRESHOLD ? 'ja-JP' : 'en-US';
}
