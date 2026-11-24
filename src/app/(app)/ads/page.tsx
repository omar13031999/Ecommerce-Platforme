import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { resolveRange, todayInAlgiers } from '@/lib/dates';
import { createClient } from '@/lib/supabase/server';
import { rpc, type OperationalDashboard } from '@/lib/queries';
import { PageHeader } from '@/components/app/page-header';
import { DateRangeFilter } from '@/components/app/date-range-filter';
import { StatCard } from '@/components/app/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDZD, formatDateTime, formatNumber, formatPercent, type AppLocale } from '@/lib/format';
import { AccountRow, CampaignProductMapper, ManualAllocations } from './ads-client';

type Row = { ad_account_id: string; account_name: string; date: string; campaign_id: string | null; campaign_name: string | null; adset_id: string | null; adset_name: string | null; ad_id: string; ad_name: string | null; spend: number; spend_dzd: number | null; impressions: number; reach: number | null; clicks: number };
type Agg = { key: string; name: string; spend: number; impressions: number; clicks: number; reach: number };

function aggregate(rows: Row[], key: (r: Row) => string, name: (r: Row) => string): Agg[] {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const k = key(r);
    const a = m.get(k) ?? { key: k, name: name(r), spend: 0, impressions: 0, clicks: 0, reach: 0 };
    a.spend += Number(r.spend_dzd ?? 0);
    a.impressions += Number(r.impressions);
    a.clicks += Number(r.clicks);
    a.reach += Number(r.reach ?? 0);
    m.set(k, a);
  }
  return [...m.values()].sort((a, b) => b.spend - a.spend);
}

export default async function AdsPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const session = await requirePage('ads.view', 'finance.view');
  const range = resolveRange(await searchParams, 'last7');
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();
  const today = todayInAlgiers();
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = range.from < monthStart ? range.from : monthStart;

  const [{ data: raw }, { data: accounts }, ops, { data: products }, { data: mappings }, { data: allocations }] = await Promise.all([
    supabase.from('ad_spend_daily').select('ad_account_id, account_name, date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, spend_dzd, impressions, reach, clicks').gte('date', from).lte('date', range.to > today ? range.to : today).limit(50000),
    supabase.from('ad_accounts').select('id, external_id, name, currency, timezone, fx_rate_to_dzd, is_active, sync_from, last_synced_at, last_error').order('name'),
    rpc<OperationalDashboard>('dashboard_operational', { p_from: range.from, p_to: range.to }),
    supabase.from('products').select('id, name').eq('is_archived', false).order('name'),
    supabase.from('ad_campaign_products').select('campaign_id, product_id'),
    supabase.from('ad_manual_allocations').select('id, product_id, period_start, period_end, amount_dzd, note').order('period_start', { ascending: false }).limit(100),
  ]);
  const rows = (raw ?? []) as Row[];
  const sumFor = (f: string, to: string) => rows.filter((r) => r.date >= f && r.date <= to).reduce((s, r) => s + Number(r.spend_dzd ?? 0), 0);
  const yesterday = new Date(`${today}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const y = yesterday.toISOString().slice(0, 10);
  const w = new Date(`${today}T00:00:00Z`); w.setUTCDate(w.getUTCDate() - 6);
  const inRange = rows.filter((r) => r.date >= range.from && r.date <= range.to);
  const rangeSpend = inRange.reduce((s, r) => s + Number(r.spend_dzd ?? 0), 0);
  const c = ops.counts;
  const per = (n: number) => (n > 0 ? formatDZD(rangeSpend / n, locale) : '—');
  const campaigns = aggregate(inRange, (r) => r.campaign_id ?? '-', (r) => r.campaign_name ?? '—');

  const breakdown = (list: Agg[]) => (
    <Table>
      <THead><TR><TH>{t('common.name')}</TH><TH>{t('ads.spendDzd')}</TH><TH>{t('ads.impressions')}</TH><TH>{t('ads.clicks')}</TH><TH>{t('ads.ctr')}</TH><TH>{t('ads.cpc')}</TH><TH>{t('ads.cpm')}</TH></TR></THead>
      <TBody>
        {list.slice(0, 200).map((a) => (
          <TR key={a.key}>
            <TD className="max-w-[320px] truncate font-medium" title={a.name}>{a.name}</TD>
            <TD className="tabular">{formatDZD(a.spend, locale)}</TD>
            <TD className="tabular">{formatNumber(a.impressions, locale)}</TD>
            <TD className="tabular">{formatNumber(a.clicks, locale)}</TD>
            <TD className="tabular">{formatPercent(a.impressions ? a.clicks / a.impressions : null, locale)}</TD>
            <TD className="tabular">{a.clicks ? formatDZD(a.spend / a.clicks, locale) : '—'}</TD>
            <TD className="tabular">{a.impressions ? formatDZD((a.spend / a.impressions) * 1000, locale) : '—'}</TD>
          </TR>
        ))}
        {!list.length ? <TR><TD colSpan={7} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
      </TBody>
    </Table>
  );

  return (
    <div className="grid gap-5">
      <PageHeader title={t('ads.title')} description={t('ads.subtitle')} actions={<DateRangeFilter range={range} />} />
      {!accounts?.length ? (
        <Card><CardContent className="p-4 text-sm">{t('ads.notConnected')} {session.can('integrations.manage') ? <Link className="text-primary hover:underline" href="/settings/integrations">{t('ads.connectMeta')} →</Link> : null}</CardContent></Card>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('ads.today')} value={formatDZD(sumFor(today, today), locale)} />
        <StatCard label={t('ads.yesterday')} value={formatDZD(sumFor(y, y), locale)} />
        <StatCard label={t('ads.week')} value={formatDZD(sumFor(w.toISOString().slice(0, 10), today), locale)} />
        <StatCard label={t('ads.month')} value={formatDZD(sumFor(monthStart, today), locale)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label={`${t('ads.spendDzd')} (${t(`range.${range.preset}`)})`} value={formatDZD(rangeSpend, locale)} />
        <StatCard label={t('ads.costPerConfirmed')} value={per(c.confirmed)} />
        <StatCard label={t('ads.costPerDistributed')} value={per(c.distributed + c.delivered)} />
        <StatCard label={t('ads.costPerDelivered')} value={per(c.delivered)} />
      </div>
      <Card>
        <CardContent className="pt-4">
          <Tabs defaultValue="campaign">
            <TabsList>
              <TabsTrigger value="account">{t('ads.byAccount')}</TabsTrigger>
              <TabsTrigger value="campaign">{t('ads.byCampaign')}</TabsTrigger>
              <TabsTrigger value="adset">{t('ads.byAdset')}</TabsTrigger>
              <TabsTrigger value="ad">{t('ads.byAd')}</TabsTrigger>
            </TabsList>
            <TabsContent value="account">{breakdown(aggregate(inRange, (r) => r.ad_account_id, (r) => r.account_name))}</TabsContent>
            <TabsContent value="campaign">{breakdown(campaigns)}</TabsContent>
            <TabsContent value="adset">{breakdown(aggregate(inRange, (r) => r.adset_id ?? '-', (r) => r.adset_name ?? '—'))}</TabsContent>
            <TabsContent value="ad">{breakdown(aggregate(inRange, (r) => r.ad_id, (r) => r.ad_name ?? r.ad_id))}</TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      {accounts?.length ? (
        <Card>
          <CardHeader><CardTitle>{t('ads.accounts')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead><TR><TH>{t('common.name')}</TH><TH>{t('ads.currency')}</TH><TH>{t('ads.fxRate')}</TH><TH>{t('ads.syncFrom')}</TH><TH>{t('common.active')}</TH><TH>{t('common.lastSync')}</TH><TH /></TR></THead>
              <TBody>
                {accounts.map((a) => (
                  <AccountRow key={a.id} canManage={session.can('ads.manage')} account={{ ...a, fx_rate_to_dzd: a.fx_rate_to_dzd === null ? null : Number(a.fx_rate_to_dzd) }} lastSync={a.last_synced_at ? formatDateTime(a.last_synced_at, locale) : t('common.never')} />
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
      {session.can('ads.manage') ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <CampaignProductMapper campaigns={campaigns.filter((x) => x.key !== '-').map((x) => ({ id: x.key, name: x.name }))} products={products ?? []} mappings={mappings ?? []} />
          <ManualAllocations products={products ?? []} items={(allocations ?? []).map((a) => ({ ...a, amount_dzd: Number(a.amount_dzd) }))} />
        </div>
      ) : null}
    </div>
  );
}
