import 'server-only';
import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { dueSheetSources, syncSheetSource } from './sheets-sync';
import { autoSubmitConfirmed, pollProvider } from './delivery';
import { syncAdAccount } from './meta-sync';

type JobResult = { job: string; ok: boolean; skipped?: string; result?: unknown; error?: string };

/** Run `fn` only if no other instance holds the lease (overlapping cron calls). */
async function withLease(name: string, ttlSeconds: number, fn: () => Promise<unknown>): Promise<JobResult> {
  const db = createAdminClient();
  const holder = randomUUID();
  const { data: acquired } = await db.rpc('acquire_job_lease', { p_name: name, p_holder: holder, p_ttl_seconds: ttlSeconds });
  if (!acquired) return { job: name, ok: true, skipped: 'locked' };
  try {
    return { job: name, ok: true, result: await fn() };
  } catch (e) {
    console.error(`[job:${name}]`, e);
    return { job: name, ok: false, error: (e as Error).message };
  } finally {
    await db.rpc('release_job_lease', { p_name: name, p_holder: holder });
  }
}

async function settled<T>(items: string[], fn: (id: string) => Promise<T>) {
  const out: Record<string, unknown> = {};
  for (const id of items) {
    try {
      out[id] = await fn(id);
    } catch (e) {
      out[id] = { error: (e as Error).message };
    }
  }
  return out;
}

/** Entry point for the scheduler (cron hits /api/cron every few minutes). */
export async function runScheduledJobs(only?: string[]): Promise<JobResult[]> {
  const db = createAdminClient();
  const want = (j: string) => !only?.length || only.includes(j);
  const results: JobResult[] = [];

  if (want('assignment')) {
    results.push(await withLease('assignment', 120, async () => {
      const assigned = await db.rpc('assign_waiting_orders', { p_limit: 500 });
      const redistributed = await db.rpc('run_redistribution_sweep', { p_limit: 200 });
      return { assigned: assigned.data, redistributed: redistributed.data };
    }));
  }
  if (want('sheets')) {
    results.push(await withLease('sheets', 600, async () => settled(await dueSheetSources(), (id) => syncSheetSource(id, 'schedule'))));
  }
  if (want('delivery_poll')) {
    results.push(await withLease('delivery_poll', 900, async () => {
      const { data: providers } = await db.from('delivery_providers')
        .select('id, polling_interval_minutes, last_polled_at').eq('is_active', true).eq('polling_enabled', true);
      const due = (providers ?? []).filter((p) => !p.last_polled_at || Date.now() - Date.parse(p.last_polled_at) >= p.polling_interval_minutes * 60_000);
      return settled(due.map((p) => p.id as string), (id) => pollProvider(id, 'schedule'));
    }));
  }
  if (want('delivery_submit')) {
    results.push(await withLease('delivery_submit', 900, () => autoSubmitConfirmed()));
  }
  if (want('meta')) {
    results.push(await withLease('meta', 1800, async () => {
      const { data: accounts } = await db.from('ad_accounts').select('id, last_synced_at').eq('is_active', true);
      const due = (accounts ?? []).filter((a) => !a.last_synced_at || Date.now() - Date.parse(a.last_synced_at) >= 3 * 3600_000);
      return settled(due.map((a) => a.id as string), (id) => syncAdAccount(id, 'schedule'));
    }));
  }
  if (want('recurring_expenses')) {
    results.push(await withLease('recurring_expenses', 300, async () => {
      const { data, error } = await db.rpc('generate_recurring_expenses', {});
      if (error) throw error;
      return { generated: data };
    }));
  }
  return results;
}
