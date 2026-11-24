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
  const expected = `Bearer ${serverEnv().CRON_SECRET}`;
  if (!safeEqual(auth, expected)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const jobs = new URL(req.url).searchParams.get('jobs')?.split(',').filter(Boolean);
  const results = await runScheduledJobs(jobs);
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}

export const GET = handle;
export const POST = handle;
