import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';

export type SyncKind =
  | 'google_sheets' | 'delivery_poll' | 'delivery_submit' | 'meta_ads'
  | 'recurring_expenses' | 'assignment' | 'redistribution' | 'settlement_import' | 'ecotrack_reference';

export async function startRun(kind: SyncKind, targetId: string | null, trigger: 'schedule' | 'manual' | 'webhook' | 'retry', userId?: string | null) {
  const { data, error } = await createAdminClient()
    .from('sync_runs')
    .insert({ kind, target_id: targetId, trigger, triggered_by: userId ?? null })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function finishRun(id: string, status: 'success' | 'partial' | 'failed', stats: Record<string, unknown>, error?: string | null) {
  await createAdminClient()
    .from('sync_runs')
    .update({ status, stats, error: error ? error.slice(0, 2000) : null, finished_at: new Date().toISOString() })
    .eq('id', id);
}
