import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { readSheet } from '@/lib/integrations/google-sheets/google';
import { parseSheetDate, resolveColumns, rowFingerprint, rowsToOrders, type ColumnMapping, type ExternalOrder, type MappingOptions } from '@/lib/integrations/google-sheets/mapping';
import { aiRowToOrder } from '@/lib/integrations/google-sheets/ai-order';
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

/** Rows read by AI per sync (the rest is picked up by the next sync, every few minutes). */
const AI_ROWS_PER_SYNC = 60;

/**
 * AI mode: every row is read whole (headers + values) by the AI extractor, so
 * columns may be mixed up. Only rows not imported yet are sent (rows already in
 * the platform are owned by the confirmers). Rows the AI could not read fall
 * back to the column mapping, or are imported raw for manual completion.
 */
async function aiOrders(src: SheetSource, header: string[], rows: string[][], headerRow: number) {
  const db = createAdminClient();
  const { extractRowsWithAI } = await import('@/lib/integrations/google-sheets/ai-extract');
  const names = header.map((h, j) => String(h ?? '').trim() || `Colonne ${j + 1}`);
  const idCol = src.column_mapping.external_id ? names.findIndex((h) => h.toLowerCase() === src.column_mapping.external_id!.toLowerCase()) : -1;
  const dateCol = src.column_mapping.created_at ? names.findIndex((h) => h.toLowerCase() === src.column_mapping.created_at!.toLowerCase()) : -1;

  const candidates = rows.flatMap((row, i) => {
    if (row.every((c) => !String(c ?? '').trim())) return [];
    const cells = Object.fromEntries(names.map((h, j) => [h, String(row[j] ?? '')]));
    const externalId = (idCol >= 0 && String(row[idCol] ?? '').trim()) || rowFingerprint(row.map((c) => String(c ?? '')));
    return [{ rowNumber: headerRow + 1 + i, row, cells, externalId }];
  });

  const existing = new Set<string>();
  const ids = [...new Set(candidates.map((c) => c.externalId))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('orders').select('external_id').eq('source', 'google_sheets').eq('source_id', src.id).in('external_id', ids.slice(i, i + 200));
    for (const o of data ?? []) existing.add(o.external_id as string);
  }
  const fresh = candidates.filter((c) => !existing.has(c.externalId)).slice(0, AI_ROWS_PER_SYNC);

  const { data: catalog } = await db.from('products').select('name, sku').eq('is_archived', false).order('name').limit(500);
  const { results, errors: aiErrors } = fresh.length
    ? await extractRowsWithAI(fresh.map((c) => ({ row: c.rowNumber, cells: c.cells })), catalog ?? [])
    : { results: new Map(), errors: [] as string[] };

  const orders: ExternalOrder[] = [];
  const errors: { row: number; external_id: string | null; error: string }[] = [];
  for (const c of fresh) {
    const ai = results.get(c.rowNumber);
    const orderedAt = dateCol >= 0 ? parseSheetDate(String(c.row[dateCol] ?? ''), src.options.date_format) : null;
    if (ai) {
      orders.push(aiRowToOrder(ai, c.externalId, c.rowNumber, c.cells, orderedAt));
      continue;
    }
    // AI unavailable for this row: column mapping, else import raw for the confirmers.
    const viaMapping = Object.keys(src.column_mapping).length
      ? rowsToOrders(header, [c.row], src.column_mapping, src.options, c.rowNumber).orders[0]
      : undefined;
    orders.push(viaMapping ? { ...viaMapping, external_id: c.externalId } : {
      external_id: c.externalId, customer_name: '', phone: '', items: [], row_numbers: [c.rowNumber], ordered_at: orderedAt,
      needs_review: true, review_reason: `Import incomplet — à compléter : lecture IA impossible — ligne d'origine : ${Object.entries(c.cells).filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v.trim()}`).join(' | ')}`.slice(0, 1000),
    });
  }
  if (aiErrors.length) errors.push(...aiErrors.slice(0, 5).map((e) => ({ row: 0, external_id: null, error: e })));
  return {
    orders, errors,
    stats: { ai_rows: fresh.length, ai_extracted: results.size, ai_pending: Math.max(0, candidates.filter((c) => !existing.has(c.externalId)).length - fresh.length), unchanged_rows: existing.size, ...(aiErrors[0] ? { ai_error: aiErrors[0].slice(0, 200) } : {}) },
  };
}

export async function syncSheetSource(sourceId: string, trigger: 'schedule' | 'manual' | 'retry' = 'schedule', actorId?: string | null) {
  const db = createAdminClient();
  const { data: src, error } = await db.from('sheet_sources').select('*').eq('id', sourceId).single<SheetSource>();
  if (error || !src) throw new Error('sheet_source_not_found');
  const runId = await startRun('google_sheets', src.id, trigger, actorId);
  const stats: Record<string, number> = { rows: 0, orders: 0, created: 0, updated: 0, unchanged: 0, errors: 0, unmatched: 0 };
  try {
    const { header, rows, headerRow } = await readSourceRows(src);
    if (headerRow !== src.header_row) await db.from('sheet_sources').update({ header_row: headerRow }).eq('id', src.id);
    stats.rows = rows.length;
    let orders: ExternalOrder[];
    let errors: { row: number; external_id: string | null; error: string }[];
    const { aiExtractionAvailable } = await import('@/lib/integrations/google-sheets/ai-extract');
    if (src.options.ai_extract && aiExtractionAvailable()) {
      const r = await aiOrders(src, header, rows, headerRow);
      orders = r.orders;
      errors = r.errors;
      Object.assign(stats, r.stats);
    } else {
      const r = rowsToOrders(header, rows, src.column_mapping, src.options, headerRow + 1);
      if (!r.orders.length && r.missingColumns.length) throw new Error(missingColumnsMessage(r.missingColumns, header));
      orders = r.orders;
      errors = r.errors;
    }
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
      stats[r.action] = (stats[r.action] ?? 0) + 1;
      if (r.unmatched) stats.unmatched = (stats.unmatched ?? 0) + 1;
    }
    stats.errors = rowErrors.length;
    if (rowErrors.length) {
      await db.from('sheet_import_errors').insert(rowErrors.slice(0, 500).map((e) => ({ ...e, source_id: src.id, run_id: runId })));
    }
    if ((stats.unmatched ?? 0) > 0) {
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
