import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { getAdapter } from '@/lib/integrations/delivery/registry';
import { restStatusMap } from '@/lib/integrations/delivery/adapters/configurable-rest';
import {
  normalizeProviderStatus, splitName,
  type AdapterContext, type DeliveryAdapter, type ShipmentInput, type TrackingEvent,
} from '@/lib/integrations/delivery/types';
import { ProviderError, withRetry } from '@/lib/integrations/http';
import { AppError, fromDbError } from '@/lib/errors';
import { isDeliveryStatus, type DeliveryStatus } from '@/lib/domain/statuses';
import { getSecret } from './secrets';
import { finishRun, startRun } from './sync-log';

type ProviderRow = {
  id: string; code: string; name: string; is_active: boolean; base_url: string | null;
  config: Record<string, unknown>; polling_enabled: boolean; polling_interval_minutes: number;
  last_polled_at: string | null; webhook_enabled: boolean; webhook_token: string;
};

export async function loadProvider(providerId: string): Promise<{ provider: ProviderRow; adapter: DeliveryAdapter; ctx: AdapterContext }> {
  const db = createAdminClient();
  const { data: provider, error } = await db.from('delivery_providers').select('*').eq('id', providerId).single<ProviderRow>();
  if (error || !provider) throw new AppError('provider_not_found', 404);
  const adapter = getAdapter(provider.code);
  if (!adapter) throw new AppError('provider_adapter_missing', 400);
  const credentials = (await getSecret<Record<string, string>>('delivery_provider', provider.id)) ?? {};
  return { provider, adapter, ctx: { baseUrl: provider.base_url ?? adapter.defaultBaseUrl, credentials, config: provider.config ?? {} } };
}

/** Provider status -> internal status: DB overrides, then provider config, then adapter defaults. */
export async function mapStatus(provider: ProviderRow, adapter: DeliveryAdapter, providerStatus: string): Promise<DeliveryStatus | null> {
  const key = normalizeProviderStatus(providerStatus);
  const { data } = await createAdminClient()
    .from('delivery_status_mappings')
    .select('provider_status, internal_status')
    .eq('provider_id', provider.id);
  const override = (data ?? []).find((m) => normalizeProviderStatus(m.provider_status) === key);
  if (override) return override.internal_status as DeliveryStatus;
  const fromConfig = restStatusMap(provider.config ?? {})[key];
  if (fromConfig && isDeliveryStatus(fromConfig)) return fromConfig;
  return adapter.statusMap[key] ?? null;
}

async function buildShipmentInput(orderId: string, reference: string): Promise<ShipmentInput> {
  const db = createAdminClient();
  const { data: o, error } = await db
    .from('orders')
    .select('id, reference, customer_name, phone, phone2, wilaya_code, commune, address, delivery_type, total_amount, delivery_fee, customer_notes, wilayas(name_fr), order_items(product_id, product_name, quantity, unit_price, sku, products(sku))')
    .eq('id', orderId)
    .single();
  if (error || !o) throw new AppError('order_not_found', 404);
  const items = (o.order_items ?? []) as unknown as { product_id: string | null; product_name: string; quantity: number; unit_price: number; sku: string | null; products: { sku: string | null } | null }[];
  const { firstName, lastName } = splitName(o.customer_name);
  const wilaya = o.wilayas as unknown as { name_fr: string } | null;
  return {
    reference,
    orderId: o.id,
    orderReference: o.reference,
    customerName: o.customer_name,
    firstName,
    lastName,
    phone: o.phone,
    phone2: o.phone2,
    wilayaCode: o.wilaya_code,
    wilayaName: wilaya?.name_fr ?? null,
    commune: o.commune,
    address: o.address,
    deliveryType: o.delivery_type,
    products: items.map((i) => ({ name: i.product_name, quantity: i.quantity, unitPrice: Number(i.unit_price), sku: i.products?.sku || i.sku || null, productId: i.product_id })),
    productsLabel: items.map((i) => `${i.product_name} x${i.quantity}`).join(', '),
    codAmount: Number(o.total_amount),
    deliveryFeeCharged: Number(o.delivery_fee),
    notes: o.customer_notes,
  };
}

export type SubmitResult = { orderId: string; ok: boolean; tracking?: string; error?: string; details?: string[] };

/**
 * Idempotent submission:
 *  1. claim (DB): validates eligibility, creates/reuses the shipment row with a
 *     stable idempotency key, refuses concurrent attempts;
 *  2. if a previous attempt is ambiguous (timeout), reconcile with the provider
 *     by reference BEFORE any new creation;
 *  3. call the provider; persist success / definitive failure / ambiguity.
 */
export async function submitOrder(orderId: string, providerId: string, actorId: string | null): Promise<SubmitResult> {
  const db = createAdminClient();
  const { provider, adapter, ctx } = await loadProvider(providerId);
  if (!provider.is_active) return { orderId, ok: false, error: 'provider_inactive' };
  if (!adapter.capabilities.createShipment || !adapter.createShipment) return { orderId, ok: false, error: 'provider_manual_only' };

  const preview = await buildShipmentInput(orderId, 'preview');
  const validation = adapter.validate(preview);
  if (validation.length) return { orderId, ok: false, error: 'delivery_validation', details: validation };

  const { data: shipment, error: claimErr } = await db.rpc('claim_shipment_submission', {
    p_order_id: orderId, p_provider_id: providerId, p_actor: actorId,
  });
  if (claimErr) return { orderId, ok: false, error: fromDbError(claimErr).code };
  const sh = shipment as { id: string; idempotency_key: string; status: string };
  const input = { ...preview, reference: sh.idempotency_key };

  if (sh.status === 'unknown') {
    if (!adapter.findShipmentByReference) {
      return { orderId, ok: false, error: 'shipment_unknown_manual_check' };
    }
    try {
      const found = await adapter.findShipmentByReference(ctx, sh.idempotency_key);
      if (found) {
        await db.rpc('complete_shipment_submission', {
          p_shipment_id: sh.id, p_tracking: found.trackingNumber, p_provider_shipment_id: found.providerShipmentId ?? null,
          p_provider_reference: found.providerReference ?? sh.idempotency_key, p_label_url: found.labelUrl ?? null,
          p_request: null, p_response: found.raw as object, p_actor: actorId,
        });
        return { orderId, ok: true, tracking: found.trackingNumber };
      }
      // Provider confirms it does not exist: safe to create with the same key.
      await db.from('delivery_shipments').update({ status: 'submitting' }).eq('id', sh.id);
    } catch (e) {
      return { orderId, ok: false, error: 'reconcile_failed', details: [(e as Error).message] };
    }
  }

  await db.from('delivery_shipments').update({ attempt_count: 1, request_payload: input as unknown as object }).eq('id', sh.id);
  try {
    if (provider.code === 'ecotrack') await alignWithEcotrack(provider.id, input);
    if (provider.code === 'maystro') await attachProviderProductLinks(provider.id, input);
    const res = await adapter.createShipment(ctx, input);
    const { error } = await db.rpc('complete_shipment_submission', {
      p_shipment_id: sh.id, p_tracking: res.trackingNumber, p_provider_shipment_id: res.providerShipmentId ?? null,
      p_provider_reference: res.providerReference ?? sh.idempotency_key, p_label_url: res.labelUrl ?? null,
      p_request: input as unknown as object, p_response: (res.raw ?? {}) as object, p_actor: actorId,
    });
    if (error) throw error;
    // ECOTRACK: the parcel was created but automatic shipping ("Expédier") failed -> say so on the order.
    const validation = (res.raw as { validation?: { error?: string; success?: boolean } } | null)?.validation;
    if (provider.code === 'ecotrack' && validation && (validation.error || validation.success === false)) {
      await db.from('order_notes').insert({
        order_id: orderId, author_id: actorId,
        body: `Colis ${res.trackingNumber} créé chez ${provider.name}, mais l'expédition automatique a échoué (${validation.error ?? 'refusée'}). Cliquez « Expédier » dans le panneau ${provider.name}.`.slice(0, 4000),
      });
    }
    return { orderId, ok: true, tracking: res.trackingNumber };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError('ambiguous', (e as Error).message);
    await db.rpc('fail_shipment_submission', {
      p_shipment_id: sh.id, p_ambiguous: pe.kind === 'ambiguous', p_error_code: pe.kind,
      p_error_message: pe.message, p_request: input as unknown as object,
      p_response: (pe.body ?? null) as object | null, p_actor: actorId,
    });
    return { orderId, ok: false, error: pe.kind === 'ambiguous' ? 'submission_ambiguous' : `provider_${pe.kind}`, details: [pe.message] };
  }
}

/**
 * ECOTRACK only accepts its own commune spelling for the selected wilaya:
 * use the exact name from the imported list, or refuse before calling the API
 * (the reason is stored on the shipment and shown on the order).
 */
async function alignWithEcotrack(providerId: string, input: ShipmentInput) {
  const { resolveEcotrackCommune } = await import('./ecotrack-sync');
  const hit = input.wilayaCode && input.commune ? await resolveEcotrackCommune(providerId, input.wilayaCode, input.commune) : null;
  if (!hit) {
    throw new ProviderError('validation', `commune_unknown: « ${input.commune ?? ''} » n'est pas une commune ECOTRACK de la wilaya ${input.wilayaCode ?? '?'}. Choisissez la commune dans la liste (Modifier).`);
  }
  if (input.deliveryType === 'stopdesk' && !hit.hasStopDesk) {
    throw new ProviderError('validation', `no_stop_desk: pas de stop desk ECOTRACK à « ${hit.name} ». Choisissez une commune avec stop desk ou la livraison à domicile.`);
  }
  input.commune = hit.name;
}

/** Provider-side product ids chosen in "Lier les produits" (Maystro orders need them). */
async function attachProviderProductLinks(providerId: string, input: ShipmentInput) {
  const ids = input.products.map((p) => p.productId).filter(Boolean) as string[];
  if (!ids.length) return;
  const { data } = await createAdminClient().from('product_provider_links').select('product_id, external_id').eq('provider_id', providerId).in('product_id', ids);
  const map = new Map((data ?? []).map((l) => [l.product_id as string, l.external_id as string]));
  for (const p of input.products) if (p.productId && map.has(p.productId)) p.externalId = map.get(p.productId)!;
}

export async function submitOrders(orderIds: string[], providerId: string, actorId: string | null, trigger: 'manual' | 'schedule' = 'manual') {
  const runId = await startRun('delivery_submit', providerId, trigger, actorId);
  const results: SubmitResult[] = [];
  // Small concurrency to respect provider rate limits.
  const queue = [...orderIds];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        results.push(await submitOrder(id, providerId, actorId));
      } catch (e) {
        results.push({ orderId: id, ok: false, error: e instanceof AppError ? e.code : 'unknown' });
      }
    }
  });
  await Promise.all(workers);
  const ok = results.filter((r) => r.ok).length;
  await finishRun(runId, ok === results.length ? 'success' : ok > 0 ? 'partial' : 'failed', {
    submitted: ok, failed: results.length - ok, errors: results.filter((r) => !r.ok).slice(0, 50),
  });
  return results;
}

function dedupeKey(providerId: string, ev: TrackingEvent) {
  return ev.eventId ? `${providerId}:${ev.eventId}` : `${providerId}:${ev.trackingNumber}:${normalizeProviderStatus(ev.providerStatus)}:${ev.occurredAt ?? ''}`;
}

/** Apply provider events (from polling or webhook) idempotently. */
export async function applyEvents(provider: ProviderRow, adapter: DeliveryAdapter, events: TrackingEvent[], source: 'poll' | 'webhook') {
  const db = createAdminClient();
  let applied = 0;
  let unmatched = 0;
  let unmapped = 0;
  for (const ev of events) {
    const { data: sh } = await db
      .from('delivery_shipments')
      .select('id, order_id')
      .eq('provider_id', provider.id)
      .eq('tracking_number', ev.trackingNumber)
      .eq('is_active', true)
      .maybeSingle();
    if (!sh) {
      unmatched++;
      continue;
    }
    const internal = await mapStatus(provider, adapter, ev.providerStatus);
    if (!internal) unmapped++;
    const occurred = ev.occurredAt && !Number.isNaN(Date.parse(ev.occurredAt)) ? new Date(ev.occurredAt).toISOString() : null;
    const { data, error } = await db.rpc('apply_delivery_event', {
      p_order_id: sh.order_id, p_shipment_id: sh.id, p_provider_id: provider.id, p_source: source,
      p_provider_status: ev.providerStatus, p_internal_status: internal, p_occurred_at: occurred,
      p_payload: ev.raw as object, p_dedupe_key: dedupeKey(provider.id, ev),
    });
    if (error) throw error;
    if (data) applied++;
  }
  return { received: events.length, applied, unmatched, unmapped };
}

const FINAL: DeliveryStatus[] = ['delivered', 'returned', 'cancelled'];

/** Poll tracking for one provider (providers without webhooks, or as a safety net). */
export async function pollProvider(providerId: string, trigger: 'schedule' | 'manual' = 'schedule', actorId?: string | null) {
  const db = createAdminClient();
  const { provider, adapter, ctx } = await loadProvider(providerId);
  if (!adapter.fetchTracking) return { skipped: 'no_tracking_api' };
  const runId = await startRun('delivery_poll', providerId, trigger, actorId);
  try {
    const { data: shipments } = await db
      .from('delivery_shipments')
      .select('id, tracking_number, order_id, orders!inner(delivery_status)')
      .eq('provider_id', providerId)
      .eq('is_active', true)
      .eq('status', 'submitted')
      .not('orders.delivery_status', 'in', `(${FINAL.join(',')})`)
      .order('last_synced_at', { ascending: true, nullsFirst: true })
      .limit(200);
    const trackings = (shipments ?? []).map((s) => s.tracking_number).filter(Boolean) as string[];
    let stats = { received: 0, applied: 0, unmatched: 0, unmapped: 0, fees: 0 };
    for (let i = 0; i < trackings.length; i += 25) {
      const batch = trackings.slice(i, i + 25);
      const events = await withRetry(() => adapter.fetchTracking!(ctx, batch));
      const r = await applyEvents(provider, adapter, events, 'poll');
      stats = { ...stats, received: stats.received + r.received, applied: stats.applied + r.applied, unmatched: stats.unmatched + r.unmatched, unmapped: stats.unmapped + r.unmapped };
      if (adapter.fetchFees) {
        const fees = await withRetry(() => adapter.fetchFees!(ctx, batch));
        for (const f of fees) {
          if (f.deliveryFee === null) continue;
          const sh = (shipments ?? []).find((s) => s.tracking_number === f.trackingNumber);
          if (!sh) continue;
          await db.from('order_financials').update({
            actual_delivery_cost: f.deliveryFee, delivery_cost_source: 'provider_api',
            ...(f.returnFee != null ? { return_fee: f.returnFee } : {}),
          }).eq('order_id', sh.order_id);
          stats.fees++;
        }
      }
    }
    await db.from('delivery_providers').update({ last_polled_at: new Date().toISOString() }).eq('id', providerId);
    await finishRun(runId, 'success', { ...stats, shipments: trackings.length });
    return stats;
  } catch (e) {
    await finishRun(runId, 'failed', {}, (e as Error).message);
    await db.rpc('notify_permission_throttled', {
      p_perm: 'delivery.manage', p_type: 'sync_failed', p_params: { kind: 'delivery_poll', provider: provider.name },
      p_link: '/settings/integrations', p_window: '6 hours',
    });
    throw e;
  }
}

/** Automatic submission of confirmed orders (admin setting). */
export async function autoSubmitConfirmed(limit = 50) {
  const db = createAdminClient();
  const { data: setting } = await db.from('app_settings').select('value').eq('key', 'delivery').single();
  const value = (setting?.value ?? {}) as { auto_submit_enabled?: boolean; default_provider_id?: string | null };
  if (!value.auto_submit_enabled || !value.default_provider_id) return { skipped: 'disabled' };
  const { data: orders } = await db
    .from('orders')
    .select('id')
    .eq('confirmation_status', 'confirmed')
    .eq('delivery_status', 'not_submitted')
    .order('confirmed_at', { ascending: true })
    .limit(limit);
  if (!orders?.length) return { submitted: 0 };
  const results = await submitOrders(orders.map((o) => o.id), value.default_provider_id, null, 'schedule');
  return { submitted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
