import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { resolveRange } from '@/lib/dates';
import { rpc } from '@/lib/queries';
import { productIntelligence } from '@/lib/services/analytics';
import { PageHeader } from '@/components/app/page-header';
import { DateRangeFilter } from '@/components/app/date-range-filter';
import { StatCard } from '@/components/app/stat-card';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDZD, formatNumber, formatPercent, type AppLocale } from '@/lib/format';
import { cn } from '@/lib/utils';

const FLAG_CLASS = {
  high_performer: 'bg-green-50 text-green-700 ring-green-200',
  low_profit: 'bg-amber-50 text-amber-800 ring-amber-200',
  negative_profit: 'bg-red-50 text-red-700 ring-red-200',
  high_returns: 'bg-rose-50 text-rose-700 ring-rose-200',
  missing_cost: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
} as const;
const FLAG_KEY = { high_performer: 'highPerformer', low_profit: 'lowProfit', negative_profit: 'negativeProfit', high_returns: 'highReturns', missing_cost: 'missingCost' } as const;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const session = await requirePage('reports.operational', 'finance.view');
  const range = resolveRange(await searchParams, 'last30');
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;

  if (!session.can('finance.view')) {
    const rows = await rpc<{ product_id: string | null; product_name: string; orders: number; quantity: number; confirmed: number; cancelled: number; distributed: number; delivered: number; returned: number }[]>(
      'product_operational_stats', { p_from: range.from, p_to: range.to });
    return (
      <div>
        <PageHeader title={t('analytics.title')} actions={<DateRangeFilter range={range} />} />
        <Card className="overflow-hidden">
          <Table>
            <THead><TR><TH>{t('orders.product')}</TH><TH>{t('analytics.orders')}</TH><TH>{t('analytics.quantity')}</TH><TH>{t('analytics.confirmationRate')}</TH><TH>{t('analytics.deliveryRate')}</TH><TH>{t('analytics.returnRate')}</TH></TR></THead>
            <TBody>
              {rows.map((r) => {
                const fin = Number(r.distributed) + Number(r.delivered) + Number(r.returned);
                return (
                  <TR key={r.product_id ?? r.product_name}>
                    <TD className="font-medium">{r.product_name}</TD>
                    <TD className="tabular">{formatNumber(r.orders, locale)}</TD>
                    <TD className="tabular">{formatNumber(r.quantity, locale)}</TD>
                    <TD className="tabular">{formatPercent(r.orders ? r.confirmed / r.orders : null, locale)}</TD>
                    <TD className="tabular">{formatPercent(fin ? (Number(r.distributed) + Number(r.delivered)) / fin : null, locale)}</TD>
                    <TD className="tabular">{formatPercent(fin ? Number(r.returned) / fin : null, locale)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      </div>
    );
  }

  const { rows, unallocated, totalSpend, method } = await productIntelligence(range.from, range.to);
  return (
    <div className="grid gap-5">
      <PageHeader title={t('analytics.title')} description={t('analytics.subtitle')} actions={
        <>
          <DateRangeFilter range={range} />
          <a className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm hover:bg-accent" href={`/api/exports/products?format=xlsx&from=${range.from}&to=${range.to}`}>{t('common.exportXlsx')}</a>
        </>
      } />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t('ads.spendDzd')} value={formatDZD(totalSpend, locale)} />
        <StatCard label={t('analytics.allocationMethod')} value={<span className="text-base">{t(`analytics.method_${method}`)}</span>} hint={t('analytics.allocationNote')} />
        <StatCard label={t('analytics.unallocated')} value={formatDZD(unallocated, locale)} tone={unallocated > 0 ? 'warning' : 'default'} />
      </div>
      <Card className="overflow-hidden">
        <Table>
          <THead><TR>
            <TH>{t('orders.product')}</TH><TH>{t('analytics.orders')}</TH><TH>{t('analytics.quantity')}</TH><TH>{t('analytics.confirmed')}</TH>
            <TH>{t('analytics.cancelled')}</TH><TH>{t('analytics.distributed')}</TH><TH>{t('analytics.delivered')}</TH><TH>{t('analytics.returned')}</TH>
            <TH>{t('analytics.revenue')}</TH><TH>{t('analytics.productCost')}</TH><TH>{t('analytics.deliveryCost')}</TH><TH>{t('analytics.adCost')}</TH>
            <TH>{t('analytics.netProfit')}</TH><TH>{t('analytics.confirmationRate')}</TH><TH>{t('analytics.deliveryRate')}</TH><TH>{t('analytics.returnRate')}</TH><TH />
          </TR></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.product_id ?? r.product_name}>
                <TD className="font-medium">{r.product_name}</TD>
                <TD className="tabular">{formatNumber(r.orders, locale)}</TD>
                <TD className="tabular">{formatNumber(r.quantity, locale)}</TD>
                <TD className="tabular">{formatNumber(r.confirmed, locale)}</TD>
                <TD className="tabular">{formatNumber(r.cancelled, locale)}</TD>
                <TD className="tabular">{formatNumber(r.distributed, locale)}</TD>
                <TD className="tabular">{formatNumber(r.delivered, locale)}</TD>
                <TD className="tabular">{formatNumber(r.returned, locale)}</TD>
                <TD className="tabular whitespace-nowrap">{formatDZD(r.revenue, locale)}</TD>
                <TD className="tabular whitespace-nowrap">{formatDZD(r.product_cost, locale)}</TD>
                <TD className="tabular whitespace-nowrap">{formatDZD(r.delivery_cost, locale)}</TD>
                <TD className="tabular whitespace-nowrap">
                  {formatDZD(r.ad_attributed + r.ad_estimated, locale)}
                  <div className="text-[11px] text-muted-foreground">{t('analytics.adAttributed')} {formatDZD(r.ad_attributed, locale)} · {t('analytics.adEstimated')} {formatDZD(r.ad_estimated, locale)}</div>
                </TD>
                <TD className={cn('tabular whitespace-nowrap font-semibold', r.net_profit < 0 ? 'text-destructive' : 'text-success')}>{formatDZD(r.net_profit, locale)}</TD>
                <TD className="tabular">{formatPercent(r.confirmation_rate, locale)}</TD>
                <TD className="tabular">{formatPercent(r.delivery_rate, locale)}</TD>
                <TD className="tabular">{formatPercent(r.return_rate, locale)}</TD>
                <TD><div className="flex flex-wrap gap-1">{r.flags.map((f) => <Badge key={f} className={FLAG_CLASS[f]}>{t(`analytics.${FLAG_KEY[f]}`)}</Badge>)}</div></TD>
              </TR>
            ))}
            {!rows.length ? <TR><TD colSpan={17} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
