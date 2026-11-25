import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { listEcotrackCommunes, listEcotrackProducts } from '@/lib/integrations/delivery/adapters/ecotrack';
import { ProviderError } from '@/lib/integrations/http';
import { loadProvider } from './delivery';
import { finishRun, startRun } from './sync-log';

/** Accent/case/punctuation-insensitive key: "Bab-Ezzouar", "bab ezzouar", "BAB EZZOUAR" -> "babezzouar". */
export function communeKey(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
}

/** Replaces the ECOTRACK communes in the reference table with the provider's current list. */
export async function syncEcotrackCommunes(providerId: string): Promise<number> {
  const { ctx } = await loadProvider(providerId);
  const list = await listEcotrackCommunes(ctx);
  const seen = new Set<string>();
  const rows = list
    .filter((c) => {
      const k = `${c.wilayaCode}:${c.name.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => ({ wilaya_code: c.wilayaCode, name: c.name, postal_code: c.postalCode, has_stop_desk: c.hasStopDesk, is_active: c.isActive, source: 'ecotrack' }));
  if (!rows.length) throw new ProviderError('validation', 'empty_commune_list');
  const db = createAdminClient();
  const { error: delErr } = await db.from('communes').delete().eq('source', 'ecotrack');
  if (delErr) throw delErr;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('communes').insert(rows.slice(i, i + 500));
    if (error) throw error;
  }
  return rows.length;
}

/** Creates / renames products so that SKU = ECOTRACK reference and name = ECOTRACK title, exactly. */
export async function syncEcotrackProducts(providerId: string) {
  const { ctx } = await loadProvider(providerId);
  const list = await listEcotrackProducts(ctx);
  const db = createAdminClient();
  const { data: existing, error } = await db.from('products').select('id, sku, name').not('sku', 'is', null);
  if (error) throw error;
  const bySku = new Map((existing ?? []).map((p) => [String(p.sku).toLowerCase(), p]));
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const toInsert: { sku: string; name: string; selling_price: number; is_archived: boolean }[] = [];
  for (const p of list) {
    const cur = bySku.get(p.reference.toLowerCase());
    if (!cur) toInsert.push({ sku: p.reference, name: p.title, selling_price: 0, is_archived: !p.isActive });
    else if (cur.name !== p.title || cur.sku !== p.reference) {
      const { error: upErr } = await db.from('products').update({ name: p.title, sku: p.reference }).eq('id', cur.id);
      if (upErr) throw upErr;
      updated++;
    } else unchanged++;
  }
  for (let i = 0; i < toInsert.length; i += 200) {
    const { data: ins, error: insErr } = await db.from('products').insert(toInsert.slice(i, i + 200)).select('id, sku, name');
    if (insErr) throw insErr;
    for (const p of ins ?? []) bySku.set(String(p.sku).toLowerCase(), p);
    created += Math.min(200, toInsert.length - i);
  }

  // Stock mirror (physical / reserved / available at the delivery company).
  const now = new Date().toISOString();
  const stockRows = list.flatMap((p) => {
    const prod = bySku.get(p.reference.toLowerCase());
    return prod ? [{ product_id: prod.id, provider_id: providerId, physical: p.physical ?? 0, reserved: p.reserved ?? 0, available: p.available ?? 0, synced_at: now }] : [];
  });
  for (let i = 0; i < stockRows.length; i += 500) {
    const { error: stErr } = await db.from('product_provider_stock').upsert(stockRows.slice(i, i + 500), { onConflict: 'product_id,provider_id' });
    if (stErr) throw stErr;
  }
  await db.from('product_provider_stock').delete().eq('provider_id', providerId).lt('synced_at', now);
  await db.from('delivery_providers').update({ stock_synced_at: now }).eq('id', providerId);
  return { total: list.length, created, updated, unchanged, stock: stockRows.length };
}

/**
 * Exact ECOTRACK spelling of a commune for a wilaya, or null when it does not
 * exist there. Imports the commune list on first use.
 */
export async function resolveEcotrackCommune(providerId: string, wilayaCode: number, commune: string): Promise<{ name: string; hasStopDesk: boolean } | null> {
  const db = createAdminClient();
  const load = () => db.from('communes').select('name, has_stop_desk').eq('source', 'ecotrack').eq('wilaya_code', wilayaCode);
  let { data } = await load();
  if (!data?.length) {
    const { count } = await db.from('communes').select('id', { count: 'exact', head: true }).eq('source', 'ecotrack');
    if (!count) {
      await syncEcotrackCommunes(providerId);
      ({ data } = await load());
    }
  }
  const key = communeKey(commune);
  const hit = (data ?? []).find((c) => communeKey(c.name) === key);
  return hit ? { name: hit.name, hasStopDesk: hit.has_stop_desk } : null;
}

/** Every 30 min: products + stock; once a day: communes — for every active ECOTRACK provider. */
export async function syncEcotrackReferences() {
  const db = createAdminClient();
  const { data: providers } = await db.from('delivery_providers').select('id').eq('code', 'ecotrack').eq('is_active', true);
  const out: Record<string, unknown> = {};
  for (const p of providers ?? []) {
    const { data: prov } = await db.from('delivery_providers').select('stock_synced_at').eq('id', p.id).single();
    if (prov?.stock_synced_at && Date.now() - Date.parse(prov.stock_synced_at) < 30 * 60_000) continue;
    const { data: lastCommunes } = await db.from('communes').select('updated_at').eq('source', 'ecotrack').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    const communesDue = !lastCommunes || Date.now() - Date.parse(lastCommunes.updated_at) >= 24 * 3600_000;
    const runId = await startRun('ecotrack_reference', p.id, 'schedule', null);
    try {
      const communes = communesDue ? await syncEcotrackCommunes(p.id) : null;
      const products = await syncEcotrackProducts(p.id);
      await finishRun(runId, 'success', { communes, ...products });
      out[p.id] = { communes, ...products };
    } catch (e) {
      await finishRun(runId, 'failed', {}, (e as Error).message);
      out[p.id] = { error: (e as Error).message };
    }
  }
  return out;
}
