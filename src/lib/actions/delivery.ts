'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth/session';
import { AppError, fromDbError, runAction } from '@/lib/errors';
import { pollProvider } from '@/lib/services/delivery';
import { parseTabularFile } from '@/lib/services/tabular';
import { parseAmount, parseSheetDate } from '@/lib/integrations/google-sheets/mapping';
import { startRun, finishRun } from '@/lib/services/sync-log';

export async function pollProviderNow(providerId: string) {
  return runAction(async () => {
    const s = await requireUser('delivery.manage');
    return pollProvider(z.guid().parse(providerId), 'manual', s.userId);
  });
}

const settlementSchema = z.object({
  orderId: z.guid(),
  collected_amount: z.coerce.number().min(0).nullable(),
  provider_fees: z.coerce.number().min(0).nullable(),
  transferred_amount: z.coerce.number().min(0).nullable(),
  transfer_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  payment_reference: z.string().trim().max(120).nullable(),
  notes: z.string().trim().max(1000).nullable(),
  not_applicable: z.boolean().default(false),
});

export async function saveSettlement(input: z.input<typeof settlementSchema>) {
  return runAction(async () => {
    const s = await requireUser('finance.manage');
    const p = settlementSchema.parse(input);
    const supabase = await createClient();
    const { error } = await supabase.from('cod_settlements').update({
      collected_amount: p.collected_amount, provider_fees: p.provider_fees, transferred_amount: p.transferred_amount,
      transfer_date: p.transfer_date, payment_reference: p.payment_reference, notes: p.notes, updated_by: s.userId,
      status: p.not_applicable ? 'not_applicable' : 'pending',
    }).eq('order_id', p.orderId);
    if (error) throw fromDbError(error);
  });
}

/**
 * Import a provider statement (CSV/XLSX). Rows are matched by tracking number.
 * Recognised columns: tracking, collected, fees, transferred, transfer_date,
 * reference, delivery_cost, return_fee. Finance permission required; writes go
 * through the user's RLS-scoped client.
 */
export async function importSettlementFile(formData: FormData) {
  return runAction(async () => {
    const s = await requireUser('finance.manage');
    const file = formData.get('file');
    if (!(file instanceof File)) throw new AppError('invalid_file');
    if (file.size > 5 * 1024 * 1024) throw new AppError('file_too_large');
    const rows = await parseTabularFile(file);
    const supabase = await createClient();
    const runId = await startRun('settlement_import', null, 'manual', s.userId);
    let matched = 0;
    let unmatched = 0;
    for (const r of rows) {
      const tracking = (r.tracking ?? r.tracking_number ?? '').trim();
      if (!tracking) continue;
      const { data: order } = await supabase.from('orders').select('id').eq('tracking_number', tracking).maybeSingle();
      if (!order) {
        unmatched++;
        continue;
      }
      const transferDate = parseSheetDate(r.transfer_date ?? r.date ?? '')?.slice(0, 10) ?? null;
      const patch: Record<string, unknown> = {};
      if (r.collected) patch.collected_amount = parseAmount(r.collected);
      if (r.fees) patch.provider_fees = parseAmount(r.fees);
      if (r.transferred) patch.transferred_amount = parseAmount(r.transferred);
      if (transferDate) patch.transfer_date = transferDate;
      if (r.reference) patch.payment_reference = r.reference;
      if (r.batch) patch.batch_reference = r.batch;
      if (Object.keys(patch).length) {
        patch.updated_by = s.userId;
        await supabase.from('cod_settlements').upsert({ order_id: order.id, ...patch }, { onConflict: 'order_id' });
      }
      const fin: Record<string, unknown> = {};
      if (r.delivery_cost) { fin.actual_delivery_cost = parseAmount(r.delivery_cost); fin.delivery_cost_source = 'import'; }
      if (r.return_fee) fin.return_fee = parseAmount(r.return_fee);
      if (Object.keys(fin).length) await supabase.from('order_financials').update(fin).eq('order_id', order.id);
      matched++;
    }
    await finishRun(runId, unmatched ? 'partial' : 'success', { matched, unmatched, rows: rows.length });
    return { matched, unmatched };
  });
}

/** Import delivery statuses for providers without API (tracking, status). */
export async function importDeliveryStatuses(formData: FormData) {
  return runAction(async () => {
    await requireUser('delivery.manage');
    const file = formData.get('file');
    if (!(file instanceof File)) throw new AppError('invalid_file');
    if (file.size > 5 * 1024 * 1024) throw new AppError('file_too_large');
    const rows = await parseTabularFile(file);
    const supabase = await createClient();
    let matched = 0;
    let unmatched = 0;
    for (const r of rows) {
      const tracking = (r.tracking ?? '').trim();
      const status = (r.status ?? '').trim();
      if (!tracking || !status) continue;
      const { data: order } = await supabase.from('orders').select('id, delivery_provider_id').eq('tracking_number', tracking).maybeSingle();
      if (!order) { unmatched++; continue; }
      const { error } = await supabase.rpc('set_delivery_status_manual', {
        p_order_id: order.id, p_status: status, p_tracking: null, p_provider_id: order.delivery_provider_id, p_note: 'import',
      });
      if (error) unmatched++;
      else matched++;
    }
    return { matched, unmatched };
  });
}

/** Provider credential/config management (integrations.manage). */
const providerSchema = z.object({
  id: z.guid().optional(),
  code: z.enum(['manual', 'rest']),
  name: z.string().trim().min(1).max(80),
  is_active: z.boolean(),
  base_url: z.string().trim().url().or(z.literal('')).optional(),
  config: z.string().max(50_000).optional(),
  webhook_enabled: z.boolean(),
  polling_enabled: z.boolean(),
  polling_interval_minutes: z.coerce.number().int().min(5).max(1440),
  tracking_url_template: z.string().trim().max(300).optional(),
  credentials: z.record(z.string(), z.string().max(2000)).optional(),
});

export async function saveProvider(input: z.input<typeof providerSchema>) {
  return runAction(async () => {
    await requireUser('integrations.manage');
    const p = providerSchema.parse(input);
    let config: Record<string, unknown> = {};
    if (p.config?.trim()) {
      try { config = JSON.parse(p.config) as Record<string, unknown>; } catch { throw new AppError('invalid_json'); }
    }
    const supabase = await createClient();
    const row = {
      code: p.code, name: p.name, is_active: p.is_active, base_url: p.base_url || null, config,
      webhook_enabled: p.webhook_enabled, polling_enabled: p.polling_enabled, polling_interval_minutes: p.polling_interval_minutes,
      tracking_url_template: p.tracking_url_template || null,
    };
    const { data, error } = p.id
      ? await supabase.from('delivery_providers').update(row).eq('id', p.id).select('id').single()
      : await supabase.from('delivery_providers').insert(row).select('id').single();
    if (error) throw fromDbError(error);
    const creds = Object.fromEntries(Object.entries(p.credentials ?? {}).filter(([, v]) => v.trim() !== ''));
    if (Object.keys(creds).length) {
      const { getSecret, setSecret } = await import('@/lib/services/secrets');
      const current = (await getSecret<Record<string, string>>('delivery_provider', data.id)) ?? {};
      await setSecret('delivery_provider', data.id, { ...current, ...creds });
      await createAdminClient().from('delivery_providers').update({ credentials_configured: true }).eq('id', data.id);
    }
    return data.id as string;
  });
}

export async function testProvider(providerId: string) {
  return runAction(async () => {
    await requireUser('integrations.manage');
    const { loadProvider } = await import('@/lib/services/delivery');
    const { adapter, ctx } = await loadProvider(z.guid().parse(providerId));
    const db = createAdminClient();
    try {
      if (!adapter.testConnection) throw new Error('not_supported');
      await adapter.testConnection(ctx);
      await db.from('delivery_providers').update({ last_test_at: new Date().toISOString(), last_test_ok: true }).eq('id', providerId);
      return { ok: true as const };
    } catch (e) {
      await db.from('delivery_providers').update({ last_test_at: new Date().toISOString(), last_test_ok: false }).eq('id', providerId);
      return { ok: false as const, error: (e as Error).message.slice(0, 300) };
    }
  });
}

const mappingSchema = z.object({ providerId: z.guid(), provider_status: z.string().trim().min(1).max(120), internal_status: z.string() });
export async function saveStatusMapping(input: z.input<typeof mappingSchema>) {
  return runAction(async () => {
    await requireUser('delivery.manage');
    const p = mappingSchema.parse(input);
    const supabase = await createClient();
    const { error } = await supabase.from('delivery_status_mappings').upsert(
      { provider_id: p.providerId, provider_status: p.provider_status, internal_status: p.internal_status },
      { onConflict: 'provider_id,provider_status' },
    );
    if (error) throw fromDbError(error);
  });
}

const rateSchema = z.object({ providerId: z.guid(), wilaya_code: z.coerce.number().int().min(1).max(58), home_cost: z.coerce.number().min(0).nullable(), stopdesk_cost: z.coerce.number().min(0).nullable(), return_cost: z.coerce.number().min(0).nullable() });
export async function saveRates(input: z.input<typeof rateSchema>[]) {
  return runAction(async () => {
    await requireUser('finance.manage');
    const rows = z.array(rateSchema).max(60).parse(input).map((r) => ({ provider_id: r.providerId, wilaya_code: r.wilaya_code, home_cost: r.home_cost, stopdesk_cost: r.stopdesk_cost, return_cost: r.return_cost }));
    const supabase = await createClient();
    const { error } = await supabase.from('delivery_rates').upsert(rows, { onConflict: 'provider_id,wilaya_code' });
    if (error) throw fromDbError(error);
  });
}
