import { NextResponse } from 'next/server';
import { serverEnv } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { runScheduledJobs } from '@/lib/services/jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Scheduler entry point. Call every 5 minutes with
 *   Authorization: Bearer <CRON_SECRET>
 * Optional ?jobs=assignment,sheets,delivery_poll,delivery_submit,meta,recurring_expenses
 * Each job is protected by a DB lease, so overlapping calls are harmless.
 */
async function handle(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  let expected: string;
  try {
    expected = `Bearer ${serverEnv().CRON_SECRET}`;
  } catch (e) {
    console.error('[cron] server environment incomplete:', (e as Error).message);
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  if (!safeEqual(auth, expected)) {
    console.warn('[cron] rejected call without valid secret');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const jobs = new URL(req.url).searchParams.get('jobs')?.split(',').filter(Boolean);
  const started = Date.now();
  const results = await runScheduledJobs(jobs);
  console.log(`[cron] ${results.map((r) => `${r.job}:${r.ok ? (r.skipped ?? 'ok') : 'FAILED'}`).join(' ')} (${Date.now() - started}ms)`);
  // Per-item outcome of the import/sync jobs (failures are otherwise hidden behind "ok").
  for (const r of results) {
    if (!r.ok && r.error) console.error(`[cron] ${r.job} failed: ${r.error}`);
    if (!['sheets', 'delivery_poll', 'ecotrack_reference'].includes(r.job) || !r.result || typeof r.result !== 'object') continue;
    for (const [id, out] of Object.entries(r.result as Record<string, unknown>)) {
      const line = `[cron] ${r.job} ${id.slice(0, 8)}: ${JSON.stringify(out).slice(0, 400)}`;
      if (out && typeof out === 'object' && 'error' in out) console.error(line);
      else console.log(line);
    }
  }
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}

export const GET = handle;
export const POST = handle;
