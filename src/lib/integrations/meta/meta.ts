import 'server-only';
import { serverEnv } from '@/lib/env';
import { hmacSha256 } from '@/lib/crypto';
import { httpJson, ProviderError } from '@/lib/integrations/http';

/** Official Meta Graph API (Marketing API / Ads Insights). Minimum scope: ads_read. */
export const META_SCOPES = ['ads_read'];

function graph(path: string) {
  return `https://graph.facebook.com/${serverEnv().META_GRAPH_VERSION}/${path.replace(/^\//, '')}`;
}
function redirectUri() {
  return `${serverEnv().APP_URL}/api/oauth/meta/callback`;
}
/** appsecret_proof secures server-to-server calls made with a user token. */
function proof(token: string) {
  return hmacSha256(serverEnv().META_APP_SECRET ?? '', token, 'hex');
}

export type MetaToken = { access_token: string; expires_at: number | null };

export function metaAuthUrl(state: string) {
  const env = serverEnv();
  const u = new URL(`https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set('client_id', env.META_APP_ID ?? '');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('state', state);
  u.searchParams.set('scope', META_SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  return u.toString();
}

type TokenRes = { access_token: string; expires_in?: number };

/** code -> short-lived token -> long-lived token (~60 days). */
export async function exchangeMetaCode(code: string): Promise<MetaToken> {
  const env = serverEnv();
  const short = await httpJson<TokenRes>({
    url: graph('oauth/access_token'),
    query: { client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: redirectUri(), code },
  });
  const long = await httpJson<TokenRes>({
    url: graph('oauth/access_token'),
    query: { grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: short.data.access_token },
  });
  return { access_token: long.data.access_token, expires_at: long.data.expires_in ? Date.now() + long.data.expires_in * 1000 : null };
}

function mapMetaError(e: unknown): never {
  if (e instanceof ProviderError) {
    const err = (e.body as { error?: { code?: number; message?: string } } | undefined)?.error;
    if (err?.code === 190 || err?.code === 102) throw new ProviderError('auth', 'meta_token_invalid', e.status, e.body);
    if (err?.code === 4 || err?.code === 17 || err?.code === 32 || err?.code === 613 || err?.code === 80004) {
      throw new ProviderError('rate_limited', err.message ?? 'meta_rate_limited', e.status, e.body);
    }
  }
  throw e;
}

async function get<T>(token: string, path: string, query: Record<string, string | number | undefined> = {}) {
  try {
    const { data } = await httpJson<T>({ url: graph(path), query: { ...query, access_token: token, appsecret_proof: proof(token) }, timeoutMs: 60000 });
    return data;
  } catch (e) {
    mapMetaError(e);
  }
}

async function getAllPages<T>(token: string, path: string, query: Record<string, string | number | undefined>): Promise<T[]> {
  const out: T[] = [];
  let page = await get<{ data: T[]; paging?: { next?: string; cursors?: { after?: string } } }>(token, path, query);
  out.push(...page.data);
  let guard = 0;
  while (page.paging?.next && page.paging.cursors?.after && guard++ < 500) {
    page = await get(token, path, { ...query, after: page.paging.cursors.after });
    out.push(...page.data);
  }
  return out;
}

export async function metaMe(token: string) {
  return get<{ id: string; name: string }>(token, 'me', { fields: 'id,name' });
}

export type MetaAdAccount = { id: string; account_id: string; name: string; currency: string; timezone_name: string; account_status: number };
export async function metaAdAccounts(token: string) {
  return getAllPages<MetaAdAccount>(token, 'me/adaccounts', { fields: 'id,account_id,name,currency,timezone_name,account_status', limit: 100 });
}

export type MetaInsightRow = {
  date_start: string; date_stop: string; account_currency?: string;
  campaign_id?: string; campaign_name?: string; adset_id?: string; adset_name?: string; ad_id: string; ad_name?: string;
  spend?: string; impressions?: string; reach?: string; clicks?: string; cpm?: string; cpc?: string; ctr?: string;
  actions?: { action_type: string; value: string }[];
};

/** Daily ad-level insights for a date range (dates in the ad account's timezone). */
export async function metaDailyInsights(token: string, actId: string, since: string, until: string) {
  return getAllPages<MetaInsightRow>(token, `${actId}/insights`, {
    level: 'ad',
    time_increment: 1,
    time_range: JSON.stringify({ since, until }),
    fields: 'date_start,date_stop,account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,cpm,cpc,ctr,actions',
    limit: 500,
  });
}
