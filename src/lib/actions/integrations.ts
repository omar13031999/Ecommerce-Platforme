'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth/session';
import { AppError, fromDbError, runAction } from '@/lib/errors';
import { listWorksheets, readSheet } from '@/lib/integrations/google-sheets/google';
import { extractSpreadsheetId, rowsToOrders, MAPPABLE_FIELDS } from '@/lib/integrations/google-sheets/mapping';
import { googleAccessToken } from '@/lib/services/google';
import { syncSheetSource } from '@/lib/services/sheets-sync';
import { deleteSecret } from '@/lib/services/secrets';
import { ProviderError } from '@/lib/integrations/http';

function providerFail(e: unknown): never {
  if (e instanceof ProviderError) throw new AppError(`provider_${e.kind}`, 400, { message: [e.message] });
  throw e;
}

export async function loadSpreadsheet(input: { connectionId: string; spreadsheet: string; worksheet?: string; headerRow?: number }) {
  return runAction(async () => {
    await requireUser('integrations.manage');
    const p = z.object({ connectionId: z.string().uuid(), spreadsheet: z.string().min(5).max(300), worksheet: z.string().max(200).optional(), headerRow: z.number().int().min(1).max(1000).optional() }).parse(input);
    const id = extractSpreadsheetId(p.spreadsheet);
    if (!id) throw new AppError('invalid_input');
    try {
      const token = await googleAccessToken(p.connectionId);
      const meta = await listWorksheets(token, id);
      const ws = p.worksheet && meta.sheets.includes(p.worksheet) ? p.worksheet : meta.sheets[0];
      const preview = ws ? await readSheet(token, id, ws, p.headerRow ?? 1) : { header: [], rows: [] };
      return { spreadsheetId: id, title: meta.title, sheets: meta.sheets, worksheet: ws ?? null, header: preview.header.map(String), sample: preview.rows.slice(0, 3) };
    } catch (e) { providerFail(e); }
  });
}

const mappingSchema = z.record(z.enum(MAPPABLE_FIELDS), z.string().max(200));
const sourceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  connection_id: z.string().uuid(),
  spreadsheet_id: z.string().min(10).max(200),
  worksheet_title: z.string().min(1).max(200),
  header_row: z.number().int().min(1).max(1000),
  column_mapping: mappingSchema,
  options: z.object({
    multi_product_separator: z.string().max(5).optional(),
    group_rows_by_external_id: z.boolean().optional(),
    price_is_line_total: z.boolean().optional(),
    date_format: z.enum(['auto', 'dmy', 'mdy']).optional(),
  }),
  sync_enabled: z.boolean(),
  sync_interval_minutes: z.number().int().min(5).max(1440),
});

export async function saveSheetSource(input: z.input<typeof sourceSchema>) {
  return runAction(async () => {
    const s = await requireUser('integrations.manage');
    const p = sourceSchema.parse(input);
    const mapping = Object.fromEntries(Object.entries(p.column_mapping).filter(([, v]) => v));
    for (const f of ['external_id', 'customer_name', 'phone', 'product_name']) if (!mapping[f]) throw new AppError('missing_columns', 400, { [f]: ['required'] });
    const supabase = await createClient();
    const row = { ...p, column_mapping: mapping };
    delete (row as { id?: string }).id;
    const { data, error } = p.id
      ? await supabase.from('sheet_sources').update(row).eq('id', p.id).select('id').single()
      : await supabase.from('sheet_sources').insert({ ...row, created_by: s.userId }).select('id').single();
    if (error) throw fromDbError(error);
    return data.id as string;
  });
}

/** Dry run: read and map the sheet without importing anything. */
export async function testSheetSource(sourceId: string) {
  return runAction(async () => {
    await requireUser('integrations.manage');
    const supabase = await createClient();
    const { data: src } = await supabase.from('sheet_sources').select('*').eq('id', z.string().uuid().parse(sourceId)).single();
    if (!src?.connection_id) throw new AppError('integration_not_configured');
    try {
      const token = await googleAccessToken(src.connection_id);
      const { header, rows } = await readSheet(token, src.spreadsheet_id, src.worksheet_title, src.header_row);
      const r = rowsToOrders(header, rows, src.column_mapping, src.options, src.header_row + 1);
      if (!r.orders.length && r.missingColumns.length) throw new AppError('missing_columns', 400, Object.fromEntries(r.missingColumns.map((c) => [c, ['missing']])));
      return { rows: rows.length, orders: r.orders.length, errors: r.errors.slice(0, 20) };
    } catch (e) { providerFail(e); }
  });
}

export async function syncSheetNow(sourceId: string) {
  return runAction(async () => {
    const s = await requireUser('integrations.manage');
    try {
      return await syncSheetSource(z.string().uuid().parse(sourceId), 'manual', s.userId);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('missing_columns:')) throw new AppError('missing_columns', 400, Object.fromEntries(e.message.slice(16).split(',').map((c) => [c, ['missing']])));
      providerFail(e);
    }
  });
}

export async function deleteSheetSource(sourceId: string) {
  return runAction(async () => {
    await requireUser('integrations.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('sheet_sources').delete().eq('id', z.string().uuid().parse(sourceId));
    if (error) throw fromDbError(error);
  });
}

export async function disconnectConnection(connectionId: string) {
  return runAction(async () => {
    await requireUser('integrations.manage');
    const id = z.string().uuid().parse(connectionId);
    await deleteSecret('connection', id);
    const { createAdminClient } = await import('@/lib/supabase/admin');
    await createAdminClient().from('integration_connections').update({ status: 'revoked' }).eq('id', id);
  });
}
