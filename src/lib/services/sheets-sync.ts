import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { readSheet } from '@/lib/integrations/google-sheets/google';
import { rowsToOrders, type ColumnMapping, type MappingOptions } from '@/lib/integrations/google-sheets/mapping';
import { withRetry } from '@/lib/integrations/http';
import { googleAccessToken } from './google';
import { finishRun, startRun } from './sync-log';

type SheetSource = {
  id: string; name: string; connection_id: string | null; spreadsheet_id: string; worksheet_title: string;
  header_row: number; column_mapping: ColumnMapping; options: MappingOptions; consecutive_failures: number;
};

export async function syncSheetSource(sourceId: string, trigger: 'schedule' | 'manual' | 'retry' = 'schedule', actorId?: string | null) {
  const db = createAdminClient();
  const { data: src, error } = await db.from('sheet_sources').select('*').eq('id', sourceId).single<SheetSource>();
  if (error || !src) throw new Error('sheet_source_not_found');
  const runId = await startRun('google_sheets', src.id, trigger, actorId);
  const stats = { rows: 0, orders: 0, created: 0, updated: 0, unchanged: 0, errors: 0, unmatched: 0 };
  try {
    if (!src.connection_id) throw new Error('google_not_connected');
    const token = await googleAccessToken(src.connection_id);
    const { header, rows } = await withRetry(() => readSheet(token, src.spreadsheet_id, src.worksheet_title, src.header_row));
    stats.rows = rows.length;
    const { orders, errors, missingColumns } = rowsToOrders(header, rows, src.column_mapping, src.options, src.header_row + 1);
    if (!orders.length && missingColumns.length) throw new Error(`missing_columns:${missingColumns.join(',')}`);
    stats.orders = orders.length;

    const rowErrors: { row_number: number | null; external_id: string | null; error: string; raw?: unknown }[] =
      errors.map((e) => ({ row_number: e.row, external_id: e.external_id, error: e.error }));

    for (const order of orders) {
      const { data, error: upErr } = await db.rpc('upsert_external_order', {
        p_source: 'google_sheets', p_source_id: src.id, p_order: order,
      });
      if (upErr) {
        rowErrors.push({ row_number: order.row_numbers[0] ?? null, external_id: order.external_id, error: upErr.message, raw: order });
        continue;
      }
      const r = data as { action: 'created' | 'updated' | 'unchanged'; unmatched?: boolean };
      stats[r.action]++;
      if (r.unmatched) stats.unmatched++;
    }
    stats.errors = rowErrors.length;
    if (rowErrors.length) {
      await db.from('sheet_import_errors').insert(rowErrors.slice(0, 500).map((e) => ({ ...e, source_id: src.id, run_id: runId })));
    }
    if (stats.unmatched > 0) {
      await db.rpc('notify_permission_throttled', {
        p_perm: 'products.manage', p_type: 'unmatched_product', p_params: { count: stats.unmatched, source: src.name },
        p_link: '/products/matching', p_window: '6 hours',
      });
    }
    await db.from('sheet_sources').update({
      last_synced_at: new Date().toISOString(), last_sync_status: rowErrors.length ? 'partial' : 'success',
      last_sync_error: rowErrors.length ? `${rowErrors.length} rows` : null, consecutive_failures: 0,
    }).eq('id', src.id);
    await finishRun(runId, rowErrors.length ? 'partial' : 'success', stats);
    return stats;
  } catch (e) {
    const msg = (e as Error).message;
    await db.from('sheet_sources').update({
      last_synced_at: new Date().toISOString(), last_sync_status: 'failed', last_sync_error: msg.slice(0, 500),
      consecutive_failures: src.consecutive_failures + 1,
    }).eq('id', src.id);
    await finishRun(runId, 'failed', stats, msg);
    await db.rpc('notify_permission_throttled', {
      p_perm: 'integrations.manage', p_type: 'sync_failed', p_params: { kind: 'google_sheets', source: src.name, error: msg.slice(0, 200) },
      p_link: '/settings/integrations', p_window: '6 hours',
    });
    throw e;
  }
}

/** Sources due for a scheduled sync (exponential back-off after failures). */
export async function dueSheetSources(now = Date.now()) {
  const { data } = await createAdminClient()
    .from('sheet_sources')
    .select('id, sync_interval_minutes, last_synced_at, consecutive_failures')
    .eq('sync_enabled', true);
  return (data ?? []).filter((s) => {
    if (!s.last_synced_at) return true;
    const backoff = Math.min(2 ** s.consecutive_failures, 16);
    return now - Date.parse(s.last_synced_at) >= s.sync_interval_minutes * 60_000 * backoff;
  }).map((s) => s.id as string);
}
