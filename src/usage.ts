// Monthly character budget for Google TTS.
// Google bills per calendar month in US Pacific time, so the month key follows that clock.

const monthFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
});

export function monthKey(now: Date): string {
  const parts = monthFormat.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  return `${year}-${month}`;
}

export async function usedChars(db: D1Database, now: Date): Promise<number> {
  const row = await db
    .prepare('SELECT chars_used FROM usage WHERE month = ?')
    .bind(monthKey(now))
    .first<{ chars_used: number }>();
  return row?.chars_used ?? 0;
}

export async function remainingChars(db: D1Database, limit: number, now: Date): Promise<number> {
  return Math.max(0, limit - (await usedChars(db, now)));
}

// Adds n to this month's count only if the total stays within limit.
// The check and the add happen in one UPDATE, so two requests at once cannot both slip past the limit.
export async function reserveChars(
  db: D1Database,
  n: number,
  limit: number,
  now: Date,
): Promise<{ ok: true; used: number } | { ok: false; remaining: number }> {
  const month = monthKey(now);
  const [, update] = await db.batch([
    db.prepare('INSERT INTO usage (month, chars_used) VALUES (?, 0) ON CONFLICT(month) DO NOTHING').bind(month),
    db
      .prepare(
        'UPDATE usage SET chars_used = chars_used + ?1 WHERE month = ?2 AND chars_used + ?1 <= ?3 RETURNING chars_used',
      )
      .bind(n, month, limit),
  ]);
  const row = update.results[0] as { chars_used: number } | undefined;
  if (row) return { ok: true, used: row.chars_used };
  return { ok: false, remaining: await remainingChars(db, limit, now) };
}
