import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { monthKey, remainingChars, reserveChars, usedChars } from '../src/usage';

const LIMIT = 1000;
const now = new Date('2026-10-15T12:00:00Z');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM usage');
});

describe('monthKey', () => {
  it('uses US Pacific time', () => {
    // 2026-11-01 05:00 UTC is still Oct 31 in Los Angeles.
    expect(monthKey(new Date('2026-11-01T05:00:00Z'))).toBe('2026-10');
    expect(monthKey(new Date('2026-11-01T08:00:00Z'))).toBe('2026-11');
  });
});

describe('reserveChars', () => {
  it('allows usage up to exactly the limit', async () => {
    expect(await reserveChars(env.DB, 600, LIMIT, now)).toEqual({ ok: true, used: 600 });
    expect(await reserveChars(env.DB, 400, LIMIT, now)).toEqual({ ok: true, used: 1000 });
    expect(await remainingChars(env.DB, LIMIT, now)).toBe(0);
  });

  it('refuses one character over the limit and leaves the count unchanged', async () => {
    await reserveChars(env.DB, 600, LIMIT, now);
    expect(await reserveChars(env.DB, 401, LIMIT, now)).toEqual({ ok: false, remaining: 400 });
    expect(await usedChars(env.DB, now)).toBe(600);
  });

  it('refuses a single request larger than the limit', async () => {
    expect(await reserveChars(env.DB, 1001, LIMIT, now)).toEqual({ ok: false, remaining: 1000 });
  });

  it('starts fresh in a new month', async () => {
    await reserveChars(env.DB, 1000, LIMIT, now);
    const nextMonth = new Date('2026-11-15T12:00:00Z');
    expect(await reserveChars(env.DB, 500, LIMIT, nextMonth)).toEqual({ ok: true, used: 500 });
    expect(await usedChars(env.DB, now)).toBe(1000);
  });

  it('lets only one of two simultaneous requests through when both cannot fit', async () => {
    const results = await Promise.all([
      reserveChars(env.DB, 700, LIMIT, now),
      reserveChars(env.DB, 700, LIMIT, now),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await usedChars(env.DB, now)).toBe(700);
  });
});
