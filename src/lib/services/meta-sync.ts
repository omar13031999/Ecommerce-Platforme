import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { metaDailyInsights, type MetaToken } from '@/lib/integrations/meta/meta';
import { ProviderError, withRetry } from '@/lib/integrations/http';
import { getSecret } from './secrets';
import { finishRun, startRun } from './sync-log';

type AdAccount = {
  id: string; external_id: string; connection_id: string | null; currency: string; timezone: string | null;
  sync_from: string; last_synced_date: string | null; is_active: boolean;
};

function todayIn(tz: string | null) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Africa/Algiers' }).format(new Date());
}
function addDays(iso: string, d: number) {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
}
const num = (v?: string) => (v === undefined || v === '' ? null : Number(v));

/**
 * Incremental sync: re-reads the last 3 days (Meta finalises spend late) from
 * the last synced date, or everything from `sync_from` for historical syncs.
 * Upsert on (account, date, ad) guarantees no duplicate spend.
 */
export async function syncAdAccount(accountId: string, trigger: 'schedule' | 'manual' = 'schedule', actorId?: string | null) {
  const db = createAdminClient();
  const { data: acc } = await db.from('ad_accounts').select('*').eq('id', accountId).single<AdAccount>();
  if (!acc) throw new Error('ad_account_not_found');
  const runId = await startRun('meta_ads', acc.id, trigger, actorId);
  let rows = 0;
  try {
    if (!acc.connection_id) throw new Error('meta_not_connected');
    const token = await getSecret<MetaToken>('connection', acc.connection_id);
    if (!token) throw new ProviderError('auth', 'meta_not_connected');
    if (token.expires_at && token.expires_at < Date.now()) throw new ProviderError('auth', 'meta_token_expired');

    const until = todayIn(acc.timezone);
    let since = acc.last_synced_date ? addDays(acc.last_synced_date, -3) : acc.sync_from;
    if (since < acc.sync_from) since = acc.sync_from;
    while (since <= until) {
      const chunkEnd = addDays(since, 29) < until ? addDays(since, 29) : until;
      const data = await withRetry(() => metaDailyInsights(token.access_token, acc.external_id, since, chunkEnd), 4, 2000);
      const records = data.map((r) => ({
        ad_account_id: acc.id,
        date: r.date_start,
        campaign_id: r.campaign_id ?? null, campaign_name: r.campaign_name ?? null,
        adset_id: r.adset_id ?? null, adset_name: r.adset_name ?? null,
        ad_id: r.ad_id, ad_name: r.ad_name ?? null,
        spend: num(r.spend) ?? 0, impressions: num(r.impressions) ?? 0, reach: num(r.reach), clicks: num(r.clicks) ?? 0,
        cpm: num(r.cpm), cpc: num(r.cpc), ctr: num(r.ctr),
        results: Object.fromEntries((r.actions ?? []).map((a) => [a.action_type, Number(a.value)])),
        currency: r.account_currency ?? acc.currency,
        synced_at: new Date().toISOString(),
      }));
      for (let i = 0; i < records.length; i += 500) {
        const { error } = await db.from('ad_insights_daily').upsert(records.slice(i, i + 500), { onConflict: 'ad_account_id,date,ad_id' });
        if (error) throw error;
      }
      rows += records.length;
      since = addDays(chunkEnd, 1);
    }
    await db.from('ad_accounts').update({ last_synced_at: new Date().toISOString(), last_synced_date: until, last_error: null }).eq('id', acc.id);
    await finishRun(runId, 'success', { rows });
    return { rows };
  } catch (e) {
    const msg = (e as Error).message;
    await db.from('ad_accounts').update({ last_error: msg.slice(0, 500) }).eq('id', acc.id);
    if (e instanceof ProviderError && e.kind === 'auth' && acc.connection_id) {
      await db.from('integration_connections').update({ status: 'expired', last_error: msg }).eq('id', acc.connection_id);
    }
    await finishRun(runId, 'failed', { rows }, msg);
    await db.rpc('notify_permission_throttled', {
      p_perm: 'ads.manage', p_type: 'sync_failed', p_params: { kind: 'meta_ads', error: msg.slice(0, 200) },
      p_link: '/ads', p_window: '6 hours',
    });
    throw e;
  }
}
