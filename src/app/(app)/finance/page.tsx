import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';
import { requirePage } from '@/lib/auth/session';
import { resolveRange } from '@/lib/dates';
import { rpc, type FinancialSummary } from '@/lib/queries';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { DateRangeFilter } from '@/components/app/date-range-filter';
import { StatCard } from '@/components/app/stat-card';
import { TrendChart } from '@/components/app/charts';
import { chartColor } from '@/lib/chart-colors';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Pagination } from '@/components/app/pagination';
import { formatDZD, formatDate, type AppLocale } from '@/lib/format';
import { cn } from '@/lib/utils';

type Day = { day: string; product_revenue: number; gross_profit: number; returned_losses: number; ad_spend: number; expenses: number; net_profit: number };

function group(days: Day[], by: 'daily' | 'weekly' | 'monthly'): Day[] {
  if (by === 'daily') return days;
  const out = new Map<string, Day>();
  for (const d of days) {
    let key = d.day.slice(0, 7) + '-01';
    if (by === 'weekly') {
      const dt = new Date(`${d.day}T00:00:00Z`);
      const dow = (dt.getUTCDay() + 6) % 7; // Monday-based
      dt.setUTCDate(dt.getUTCDate() - dow);
      key = dt.toISOString().slice(0, 10);
    }
    const g = out.get(key) ?? { day: key, product_revenue: 0, gross_profit: 0, returned_losses: 0, ad_spend: 0, expenses: 0, net_profit: 0 };
    for (const k of ['product_revenue', 'gross_profit', 'returned_losses', 'ad_spend', 'expenses', 'net_profit'] as const) g[k] += Number(d[k]);
    out.set(key, g);
  }
  return [...out.values()];
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; by?: string; page?: string; bucket?: string }> }) {
  await requirePage('finance.view');
  const sp = await searchParams;
  const range = resolveRange(sp, 'this_month');
  const by = (['daily', 'weekly', 'monthly'] as const).find((b) => b === sp.by) ?? 'daily';
  const page = Math.max(1, Number(sp.page) || 1);
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();

  const [s, days] = await Promise.all([
    rpc<FinancialSummary>('financial_summary', { p_from: range.from, p_to: range.to }),
    rpc<Day[]>('profit_timeseries', { p_from: range.from, p_to: range.to }),
  ]);
  let ordersQ = supabase.from('order_profit')
    .select('order_id, reference, period_date, bucket, product_revenue, delivery_fee_charged, product_cost, delivery_cost, delivery_cost_estimated, operational_cost, gross_profit, profit_incomplete', { count: 'exact' })
    .gte('period_date', range.from).lte('period_date', range.to).not('bucket', 'in', '(not_confirmed,cancelled)')
    .order('period_date', { ascending: false }).range((page - 1) * 50, page * 50 - 1);
  if (sp.bucket) ordersQ = ordersQ.eq('bucket', sp.bucket);
  const { data: orders, count } = await ordersQ;

  const b = s.buckets;
  const tone = (v: number) => (v > 0 ? 'positive' : v < 0 ? 'negative' : 'default') as 'positive' | 'negative' | 'default';
  const incomplete = Object.values(b).reduce((x, v) => x + Number(v?.incomplete_orders ?? 0), 0);
  const estimated = Object.values(b).reduce((x, v) => x + Number(v?.estimated_delivery_cost_orders ?? 0), 0);
  const series = group(days, by);
  const exp = (kind: string) => `/api/exports/${kind}?format=xlsx&from=${range.from}&to=${range.to}`;
  const qs = (extra: Record<string, string>) => `?${new URLSearchParams({ ...(sp as Record<string, string>), ...extra }).toString()}`;

  return (
    <div className="grid gap-5">
      <PageHeader title={t('finance.title')} description={t('finance.subtitle')} actions={<DateRangeFilter range={range} />} />

      {s.warnings.length ? (
        <div className="grid gap-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          {s.warnings.map((w) => <p key={w} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />{t(`finance.warning_${w}` as 'finance.warning_incomplete_costs')}</p>)}
        </div>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t('finance.buckets')}</CardTitle><CardDescription>{t('finance.formula')}</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t('finance.potential')} value={formatDZD(s.profit.potential, locale)} hint={<>{t('finance.potentialHelp')} · {t('finance.ordersCount', { count: Number(b.potential?.orders ?? 0) })}</>} href={qs({ bucket: 'potential' })} />
          <StatCard label={t('finance.expected')} value={formatDZD(s.profit.expected, locale)} hint={<>{t('finance.expectedHelp')} · {t('finance.ordersCount', { count: Number(b.in_delivery?.orders ?? 0) + Number(b.delivered_unsettled?.orders ?? 0) })}</>} href={qs({ bucket: 'delivered_unsettled' })} />
          <StatCard label={t('finance.realized')} value={formatDZD(s.profit.realized_gross, locale)} tone={tone(s.profit.realized_gross)} hint={<>{t('finance.realizedHelp')} · {t('finance.ordersCount', { count: Number(b.realized?.orders ?? 0) })}</>} href={qs({ bucket: 'realized' })} />
          <StatCard label={t('finance.returnedLosses')} value={formatDZD(s.profit.returned_losses, locale)} tone="negative" hint={t('finance.ordersCount', { count: Number(b.returned?.orders ?? 0) })} href={qs({ bucket: 'returned' })} />
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t('finance.dailyProfit')}</CardTitle>
            <div className="flex gap-1 text-sm">
              {(['daily', 'weekly', 'monthly'] as const).map((k) => (
                <Link key={k} href={qs({ by: k })} className={cn('rounded-md px-2 py-1', by === k ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-muted')}>{t(`finance.${k}`)}</Link>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <TrendChart kind="bar" data={series} series={[
              { key: 'gross_profit', label: t('finance.grossProfit'), color: chartColor(0) },
              { key: 'ad_spend', label: t('finance.adSpend'), color: chartColor(1) },
              { key: 'expenses', label: t('finance.overhead'), color: chartColor(3) },
              { key: 'net_profit', label: t('finance.netProfit'), color: chartColor(4) },
            ]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('finance.netProfit')}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Line label={t('finance.productRevenue')} value={s.delivered_totals.product_revenue} locale={locale} />
            <Line label={t('finance.deliveryFeesCharged')} value={s.delivered_totals.delivery_fees_charged} locale={locale} />
            <Line label={t('finance.productCost')} value={-s.delivered_totals.product_cost} locale={locale} />
            <Line label={t('finance.deliveryCost')} value={-s.delivered_totals.delivery_cost} locale={locale} hint={estimated ? t('finance.estimatedDelivery', { count: estimated }) : undefined} />
            <Line label={t('finance.operationalCost')} value={-s.delivered_totals.operational_cost} locale={locale} />
            <Line label={t('finance.grossProfit')} value={s.profit.gross_delivered} locale={locale} strong />
            <Line label={`${t('finance.adSpend')} — ${t('finance.adsApi')}`} value={-s.ads.meta_spend_dzd} locale={locale} />
            <Line label={`${t('finance.adSpend')} — ${t('finance.adsManual')}`} value={-Number(s.ads.advertising_expenses)} locale={locale} />
            <Line label={t('finance.overhead')} value={-s.expenses.overhead} locale={locale} />
            <div className="my-1 border-t" />
            <Line label={t('finance.netRealized')} value={s.profit.net_realized} locale={locale} strong />
            <Line label={t('finance.netDeliveredEstimate')} value={s.profit.net_delivered_estimate} locale={locale} hint={t('common.estimated')} />
            <Line label={t('finance.netPipeline')} value={s.profit.net_pipeline_estimate} locale={locale} hint={t('common.estimated')} />
            {incomplete ? <p className="mt-2 text-xs text-warning">{t('finance.incomplete', { count: incomplete })}</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('finance.profitByOrder')}</CardTitle>
          <div className="flex flex-wrap gap-2 text-sm">
            {[['orders', 'exportOrders'], ['products', 'exportProducts'], ['daily', 'exportDaily'], ['expenses', 'exportExpenses'], ['settlements', 'exportSettlements']].map(([k, label]) => (
              <a key={k} href={exp(k!)} className="rounded-md border px-2 py-1 hover:bg-accent">{t(`finance.${label}` as 'finance.exportOrders')} (xlsx)</a>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead><TR>
              <TH>{t('orders.reference')}</TH><TH>{t('common.date')}</TH><TH>{t('finance.bucket')}</TH><TH>{t('finance.productRevenue')}</TH>
              <TH>{t('finance.deliveryFeesCharged')}</TH><TH>{t('finance.productCost')}</TH><TH>{t('finance.deliveryCost')}</TH><TH>{t('finance.operationalCost')}</TH><TH>{t('finance.grossProfit')}</TH>
            </TR></THead>
            <TBody>
              {(orders ?? []).map((o) => (
                <TR key={o.order_id}>
                  <TD><Link href={`/orders/${o.order_id}`} className="font-medium text-primary hover:underline">#{o.reference}</Link></TD>
                  <TD className="text-xs">{formatDate(o.period_date, locale)}</TD>
                  <TD className="text-xs">{t(`finance.bucket_${o.bucket}` as 'finance.bucket_realized')}</TD>
                  <TD className="tabular">{formatDZD(o.product_revenue, locale)}</TD>
                  <TD className="tabular">{formatDZD(o.delivery_fee_charged, locale)}</TD>
                  <TD className="tabular">{o.product_cost != null ? formatDZD(o.product_cost, locale) : '—'}</TD>
                  <TD className="tabular">{formatDZD(o.delivery_cost, locale)}{o.delivery_cost_estimated && o.delivery_cost != null ? <span className="text-xs text-muted-foreground"> *</span> : null}</TD>
                  <TD className="tabular">{formatDZD(o.operational_cost, locale)}</TD>
                  <TD className={cn('tabular font-medium', Number(o.gross_profit) < 0 && 'text-destructive')}>{o.profit_incomplete ? <span className="text-xs text-warning">{t('products.missingCost')}</span> : formatDZD(o.gross_profit, locale)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="px-3"><Pagination page={page} pageSize={50} total={count ?? 0} searchParams={sp as Record<string, string | undefined>} /></div>
        </CardContent>
      </Card>
    </div>
  );
}

function Line({ label, value, locale, strong, hint }: { label: string; value: number; locale: AppLocale; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={cn(strong ? 'font-semibold' : 'text-muted-foreground')}>{label}{hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}</span>
      <span className={cn('tabular whitespace-nowrap', strong && 'font-semibold', value < 0 ? 'text-destructive' : '')}>{formatDZD(value, locale)}</span>
    </div>
  );
}
