import { describe, expect, it } from 'vitest';
import { buildRss } from '../src/feed';
import type { Episode } from '../src/types';

const BASE = 'https://example.workers.dev';
const TOKEN = 'tok123';

function ep(over: Partial<Episode> & { id: string }): Episode {
  return {
    title: 'Title',
    lang: 'ja-JP',
    char_count: 100,
    total_chunks: 1,
    done_chunks: 1,
    status: 'done',
    error: null,
    audio_key: `${over.id}.mp3`,
    audio_bytes: 1000,
    duration_sec: 60,
    source_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// Without DOMParser in the workers test env, check well-formedness by hand:
// the document has one root, and every opened element tag is closed in order.
function assertWellFormed(xml: string) {
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)(?:\s[^>]*?)?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, selfClose] = m;
    if (name.startsWith('?')) continue;
    if (selfClose) continue;
    if (closing) {
      expect(stack.pop()).toBe(name);
    } else {
      stack.push(name);
    }
  }
  expect(stack).toEqual([]);
}

const itemCount = (xml: string) => (xml.match(/<item>/g) ?? []).length;

describe('buildRss', () => {
  it('includes only done episodes, newest first', () => {
    const xml = buildRss(
      [
        ep({ id: 'old', title: 'Old', created_at: '2026-01-01T00:00:00.000Z' }),
        ep({ id: 'proc', title: 'Processing', status: 'processing', created_at: '2026-03-01T00:00:00.000Z' }),
        ep({ id: 'fail', title: 'Failed', status: 'failed', created_at: '2026-04-01T00:00:00.000Z' }),
        ep({ id: 'new', title: 'New', created_at: '2026-02-01T00:00:00.000Z' }),
      ],
      BASE,
      TOKEN,
    );
    expect(itemCount(xml)).toBe(2);
    expect(xml).not.toContain('Processing');
    expect(xml).not.toContain('Failed');
    expect(xml.indexOf('<guid isPermaLink="false">new</guid>')).toBeLessThan(
      xml.indexOf('<guid isPermaLink="false">old</guid>'),
    );
  });

  it('escapes special characters in titles', () => {
    const xml = buildRss([ep({ id: 'a', title: 'A & B <test> "q"' })], BASE, TOKEN);
    expect(xml).toContain('<title>A &amp; B &lt;test&gt; &quot;q&quot;</title>');
    expect(xml).not.toContain('<test>');
    assertWellFormed(xml);
  });

  it('writes enclosure url, length and type', () => {
    const xml = buildRss([ep({ id: 'ep1', audio_bytes: 12345 })], BASE, TOKEN);
    expect(xml).toContain(
      `<enclosure url="${BASE}/audio/${TOKEN}/ep1.mp3" length="12345" type="audio/mpeg"/>`,
    );
  });

  it('strips a trailing slash from baseUrl', () => {
    const xml = buildRss([ep({ id: 'ep1' })], `${BASE}/`, TOKEN);
    expect(xml).toContain(`${BASE}/audio/${TOKEN}/ep1.mp3`);
    expect(xml).toContain(`<link>${BASE}</link>`);
  });

  it('formats durations as MM:SS or H:MM:SS', () => {
    const short = buildRss([ep({ id: 'a', duration_sec: 59 })], BASE, TOKEN);
    expect(short).toContain('<itunes:duration>00:59</itunes:duration>');
    const long = buildRss([ep({ id: 'b', duration_sec: 3661 })], BASE, TOKEN);
    expect(long).toContain('<itunes:duration>1:01:01</itunes:duration>');
  });

  it('marks the feed private with itunes:block', () => {
    const xml = buildRss([], BASE, TOKEN);
    expect(xml).toContain('<itunes:block>Yes</itunes:block>');
    expect(xml).toContain('<itunes:explicit>false</itunes:explicit>');
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
  });

  it('uses source_url as description only when present', () => {
    const xml = buildRss(
      [ep({ id: 'x', source_url: 'https://a.example/p?x=1&y=2' }), ep({ id: 'y', source_url: null })],
      BASE,
      TOKEN,
    );
    expect(xml).toContain('<description>https://a.example/p?x=1&amp;y=2</description>');
    expect(itemCount(xml)).toBe(2);
  });

  it('produces a valid channel for an empty list', () => {
    const xml = buildRss([], BASE, TOKEN);
    expect(itemCount(xml)).toBe(0);
    expect(xml).toContain('<channel>');
    expect(xml).toContain('<language>ja</language>');
    assertWellFormed(xml);
  });

  it('produces well-formed XML with items', () => {
    const xml = buildRss(
      [ep({ id: 'a', title: 'T1', source_url: 'https://x.example/?a=1&b=2' }), ep({ id: 'b', title: 'T2' })],
      BASE,
      TOKEN,
    );
    expect(itemCount(xml)).toBe(2);
    assertWellFormed(xml);
  });
});
