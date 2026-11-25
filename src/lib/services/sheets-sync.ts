import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { readSheet } from '@/lib/integrations/google-sheets/google';
import { resolveColumns, rowsToOrders, type ColumnMapping, type MappingOptions } from '@/lib/integrations/google-sheets/mapping';
import { withRetry } from '@/lib/integrations/http';
import { readPublicSheet } from '@/lib/integrations/google-sheets/public-sheet';
import { googleAccessToken } from './google';
import { finishRun, startRun } from './sync-log';

type SheetSource = {
  id: string; name: string; connection_id: string | null; spreadsheet_id: string; worksheet_title: string;
  header_row: number; column_mapping: ColumnMapping; options: MappingOptions; consecutive_failures: number;
};

type ReadableSource = Pick<SheetSource, 'connection_id' | 'spreadsheet_id' | 'worksheet_title' | 'header_row' | 'column_mapping'>;

function readRaw(src: ReadableSource, headerRow: number) {
  const connectionId = src.connection_id;
  return connectionId
    ? withRetry(async () => readSheet(await googleAccessToken(connectionId), src.spreadsheet_id, src.worksheet_title, headerRow))
    : withRetry(() => readPublicSheet(src.spreadsheet_id, src.worksheet_title, headerRow));
}

const score = (header: string[], mapping: ColumnMapping) => resolveColumns(header, mapping).found;

/**
 * Reads the sheet at the configured header row. When some mapped columns are not
 * there (header row changed, rows inserted above the header…), looks for the row
 * of the first 30 that matches the most mapped columns and uses it.
 */
export async function readSourceRows(src: ReadableSource): Promise<{ header: string[]; rows: string[][]; headerRow: number }> {
  const first = await readRaw(src, src.header_row);
  const wanted = Object.values(src.column_mapping).filter(Boolean).length;
  const firstScore = score(first.header, src.column_mapping);
  if (firstScore >= wanted) return { ...first, headerRow: src.header_row };
  const all = src.header_row === 1 ? first : await readRaw(src, 1);
  const lines = [all.header, ...all.rows];
  let best = { i: -1, s: firstScore };
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const sc = score((lines[i] ?? []).map((h) => String(h ?? '')), src.column_mapping);
    if (sc > best.s) best = { i, s: sc };
  }
  if (best.i < 0) return { ...first, headerRow: src.header_row };
  return { header: (lines[best.i] ?? []).map((h) => String(h ?? '')), rows: lines.slice(best.i + 1), headerRow: best.i + 1 };
}

/** "missing_columns:a,b|found:col1; col2" — the columns actually read help fixing the mapping. */
export function missingColumnsMessage(missing: string[], header: string[]) {
  const found = header.map((h) => String(h ?? '').trim()).filter(Boolean).slice(0, 25).join('; ');
  return `missing_columns:${missing.join(',')}|found:${found || '(vide)'}`.slice(0, 500);
}

export async function syncSheetSource(sourceId: string, trigger: 'schedule' | 'manual' | 'retry' = 'schedule', actorId?: string | null) {
  const db = createAdminClient();
  const { data: src, error } = await db.from('sheet_sources').select('*').eq('id', sourceId).single<SheetSource>();
  if (error || !src) throw new Error('sheet_source_not_found');
  const runId = await startRun('google_sheets', src.id, trigger, actorId);
  const stats = { rows: 0, orders: 0, created: 0, updated: 0, unchanged: 0, errors: 0, unmatched: 0 };
  try {
    const { header, rows, headerRow } = await readSourceRows(src);
    if (headerRow !== src.header_row) await db.from('sheet_sources').update({ header_row: headerRow }).eq('id', src.id);
    stats.rows = rows.length;
    const { orders, errors, missingColumns } = rowsToOrders(header, rows, src.column_mapping, src.options, headerRow + 1);
    if (!orders.length && missingColumns.length) throw new Error(missingColumnsMessage(missingColumns, header));
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
