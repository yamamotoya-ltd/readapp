import type { Episode } from './types';

// Private podcast feed (owner-only). Served to Apple Podcasts via a tokenized URL.
// itunes:block keeps it out of the public directory.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// 59 -> "00:59", 3661 -> "1:01:01"
function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${pad2(m)}:${pad2(r)}`;
}

export function buildRss(episodes: Episode[], baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const done = episodes
    .filter((e) => e.status === 'done')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const items = done.map((e) => {
    const lines = [
      '    <item>',
      `      <title>${esc(e.title)}</title>`,
      `      <guid isPermaLink="false">${esc(e.id)}</guid>`,
      `      <pubDate>${new Date(e.created_at).toUTCString()}</pubDate>`,
      `      <enclosure url="${esc(`${base}/audio/${token}/${e.id}.mp3`)}" length="${e.audio_bytes ?? 0}" type="audio/mpeg"/>`,
    ];
    if (e.duration_sec != null) {
      lines.push(`      <itunes:duration>${formatDuration(e.duration_sec)}</itunes:duration>`);
    }
    if (e.source_url) {
      lines.push(`      <description>${esc(e.source_url)}</description>`);
    }
    lines.push('    </item>');
    return lines.join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    '  <channel>',
    `    <title>${esc('readapp（福田専用）')}</title>`,
    `    <link>${esc(base)}</link>`,
    `    <description>${esc('記事の読み上げ（非公開）')}</description>`,
    '    <language>ja</language>',
    `    <itunes:author>${esc('readapp')}</itunes:author>`,
    '    <itunes:explicit>false</itunes:explicit>',
    '    <itunes:block>Yes</itunes:block>',
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
