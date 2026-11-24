'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth/session';
import { AppError, fromDbError, runAction } from '@/lib/errors';
import { metaAdAccounts, type MetaToken } from '@/lib/integrations/meta/meta';
import { getSecret } from '@/lib/services/secrets';
import { syncAdAccount } from '@/lib/services/meta-sync';

/** Imports the ad accounts visible to the connected Meta user. */
export async function importMetaAccounts(connectionId: string) {
  return runAction(async () => {
    await requireUser('ads.manage');
    const token = await getSecret<MetaToken>('connection', z.guid().parse(connectionId));
    if (!token) throw new AppError('integration_not_configured');
    const accounts = await metaAdAccounts(token.access_token);
    const db = createAdminClient();
    for (const a of accounts) {
      const { error } = await db.from('ad_accounts').upsert({
        platform: 'meta', external_id: a.id, connection_id: connectionId, name: a.name, currency: a.currency, timezone: a.timezone_name,
      }, { onConflict: 'platform,external_id' });
      if (error) throw fromDbError(error);
    }
    return accounts.length;
  });
}

const accountSchema = z.object({
  id: z.guid(),
  is_active: z.boolean(),
  fx_rate_to_dzd: z.union([z.coerce.number().positive().max(100000), z.literal('').transform(() => null), z.null()]),
  sync_from: z.string().date(),
});

export async function updateAdAccount(input: z.input<typeof accountSchema>) {
  return runAction(async () => {
    await requireUser('ads.manage');
    const p = accountSchema.parse(input);
    const supabase = await createClient();
    const { data: prev } = await supabase.from('ad_accounts').select('sync_from').eq('id', p.id).single();
    const { error } = await supabase.from('ad_accounts').update({
      is_active: p.is_active, fx_rate_to_dzd: p.fx_rate_to_dzd, sync_from: p.sync_from,
      // Moving the start date earlier triggers a historical re-sync.
      ...(prev && p.sync_from < prev.sync_from ? { last_synced_date: null } : {}),
    }).eq('id', p.id);
    if (error) throw fromDbError(error);
  });
}

export async function syncAdAccountNow(id: string) {
  return runAction(async () => {
    const s = await requireUser('ads.manage');
    return syncAdAccount(z.guid().parse(id), 'manual', s.userId);
  });
}

export async function mapCampaignProduct(input: { campaignId: string; productId: string; remove?: boolean }) {
  return runAction(async () => {
    await requireUser('ads.manage');
    const p = z.object({ campaignId: z.string().min(1).max(64), productId: z.guid(), remove: z.boolean().optional() }).parse(input);
    const supabase = await createClient();
    const { error } = p.remove
      ? await supabase.from('ad_campaign_products').delete().eq('campaign_id', p.campaignId).eq('product_id', p.productId)
      : await supabase.from('ad_campaign_products').upsert({ campaign_id: p.campaignId, product_id: p.productId });
    if (error) throw fromDbError(error);
  });
}

const allocSchema = z.object({ product_id: z.guid(), period_start: z.string().date(), period_end: z.string().date(), amount_dzd: z.coerce.number().min(0), note: z.string().max(500).optional() });
export async function addManualAllocation(input: z.input<typeof allocSchema>) {
  return runAction(async () => {
    await requireUser('ads.manage');
    const p = allocSchema.parse(input);
    const supabase = await createClient();
    const { error } = await supabase.from('ad_manual_allocations').insert(p);
    if (error) throw fromDbError(error);
  });
}

export async function deleteManualAllocation(id: string) {
  return runAction(async () => {
    await requireUser('ads.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('ad_manual_allocations').delete().eq('id', z.guid().parse(id));
    if (error) throw fromDbError(error);
  });
}
