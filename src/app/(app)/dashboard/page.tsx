import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AlertTriangle, CheckCircle2, Clock, Copy, PackageCheck, PhoneOff, RotateCcw, ShoppingBag, Truck, UserX, XCircle,
} from 'lucide-react';
import { requirePage } from '@/lib/auth/session';
import { rangeToInstants, resolveRange } from '@/lib/dates';
import { rpc, type FinancialSummary, type OperationalDashboard } from '@/lib/queries';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { StatCard } from '@/components/app/stat-card';
import { DateRangeFilter } from '@/components/app/date-range-filter';
import { TrendChart } from '@/components/app/charts';
import { chartColor } from '@/lib/chart-colors';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ConfirmationBadge } from '@/components/app/status-badge';
import { formatDZD, formatDateTime, formatNumber, formatPercent, type AppLocale } from '@/lib/format';
import type { ConfirmationStatus } from '@/lib/domain/statuses';

type SP = Promise<{ range?: string; from?: string; to?: string; denied?: string }>;

export default async function DashboardPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePage();
  const sp = await searchParams;
  const range = resolveRange(sp, 'today');
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const isAgent = session.profile.role === 'agent';

  const [ops, series] = await Promise.all([
    rpc<OperationalDashboard>('dashboard_operational', { p_from: range.from, p_to: range.to }),
    rpc<{ day: string; total: number; confirmed: number; cancelled: number; delivered: number; returned: number }[]>('orders_timeseries', { p_from: range.from, p_to: range.to }),
  ]);
  const c = ops.counts;
  const q = (extra: string) => `/orders?${extra}`;

  return (
    <div className="grid gap-6">
      <PageHeader
        title={t('dashboard.welcome', { name: session.profile.full_name.split(' ')[0] ?? '' })}
        description={sp.denied ? <span className="text-destructive">{t('auth.accessDenied')}</span> : undefined}
        actions={<DateRangeFilter range={range} />}
      />

      {isAgent ? <AgentPanel userId={session.userId} capacity={session.profile.max_active_orders} range={range} locale={locale} /> : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatCard label={t('dashboard.totalOrders')} value={formatNumber(c.total, locale)} icon={<ShoppingBag />} href={q('')} />
        <StatCard label={t('dashboard.newOrders')} value={formatNumber(c.new, locale)} icon={<Clock />} href={q('status=new')} />
        <StatCard label={t('dashboard.awaitingConfirmation')} value={formatNumber(c.awaiting_confirmation, locale)} icon={<PhoneOff />} href={q('status=active')} />
        <StatCard label={t('dashboard.confirmed')} value={formatNumber(c.confirmed, locale)} icon={<CheckCircle2 />} tone="positive" href={q('status=confirmed')} />
        <StatCard label={t('dashboard.cancelled')} value={formatNumber(c.cancelled, locale)} icon={<XCircle />} tone="negative" href={q('status=cancelled')} />
        <StatCard label={t('dashboard.duplicate')} value={formatNumber(c.duplicate, locale)} icon={<Copy />} tone="muted" href={q('status=duplicate')} />
        <StatCard label={t('dashboard.awaitingDelivery')} value={formatNumber(c.awaiting_delivery, locale)} icon={<PackageCheck />} href={q('status=confirmed&delivery=not_submitted')} />
        <StatCard label={t('dashboard.inTransit')} value={formatNumber(c.in_transit, locale)} icon={<Truck />} href={q('delivery=in_transit')} />
        <StatCard label={t('dashboard.distributed')} value={formatNumber(c.distributed, locale)} href={q('delivery=distributed')} />
        <StatCard label={t('dashboard.delivered')} value={formatNumber(c.delivered, locale)} tone="positive" href={q('delivery=delivered')} />
        <StatCard label={t('dashboard.returned')} value={formatNumber(c.returned, locale)} icon={<RotateCcw />} tone="negative" href={q('delivery=returned')} />
        {!isAgent ? (
          <StatCard label={t('dashboard.needsReview')} value={formatNumber(c.needs_review, locale)} icon={<AlertTriangle />} tone={c.needs_review ? 'warning' : 'default'} href={q('review=1')} />
        ) : (
          <StatCard label={t('dashboard.noAnswer')} value={formatNumber(c.no_answer, locale)} icon={<PhoneOff />} href={q('status=no_answer')} />
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t('dashboard.confirmationRate')} value={formatPercent(ops.confirmation_rate, locale)} />
        <StatCard label={t('dashboard.deliveryRate')} value={formatPercent(ops.delivery_success_rate, locale)} tone="positive" />
        <StatCard label={t('dashboard.returnRate')} value={formatPercent(ops.return_rate, locale)} tone={Number(ops.return_rate) > 0.2 ? 'negative' : 'default'} />
      </section>

      {!isAgent && c.unassigned > 0 ? (
        <Link href="/orders?queue=waiting" className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <UserX className="size-4 text-warning" />
          {t('dashboard.unassigned')}: <strong className="tabular">{c.unassigned}</strong>
        </Link>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t('dashboard.ordersTrend')}</CardTitle></CardHeader>
        <CardContent>
          <TrendChart
            data={series.map((s) => ({ ...s, day: s.day }))}
            series={[
              { key: 'total', label: t('dashboard.totalOrders'), color: chartColor(1) },
              { key: 'confirmed', label: t('dashboard.confirmed'), color: chartColor(0) },
              { key: 'delivered', label: t('dashboard.delivered'), color: chartColor(3) },
              { key: 'returned', label: t('dashboard.returned'), color: chartColor(2) },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        {session.can('team.view') ? <TeamPerformance from={range.from} to={range.to} locale={locale} /> : null}
        {session.can('reports.operational') || session.can('finance.view') ? <TopProducts from={range.from} to={range.to} locale={locale} /> : null}
      </div>

      {session.can('finance.view') ? <FinancialPanel from={range.from} to={range.to} locale={locale} /> : null}
    </div>
  );
}

async function AgentPanel({ userId, capacity, range, locale }: { userId: string; capacity: number; range: { from: string; to: string }; locale: AppLocale }) {
  const t = await getTranslations();
  const supabase = await createClient();
  const { data: workload } = await supabase.rpc('workload_statuses');
  const statuses = (workload ?? ['new']) as string[];
  const { start, end } = rangeToInstants(range);
  const [{ count: active }, { data: followUps }, { count: myConfirmed }, { data: reminders }] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('assigned_to', userId).in('confirmation_status', statuses).in('delivery_status', ['not_submitted', 'submission_failed']),
    supabase.from('orders').select('id, reference, customer_name, phone, confirmation_status, updated_at')
      .eq('assigned_to', userId).in('confirmation_status', statuses).order('confirmation_status').order('updated_at').limit(8),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('assigned_to', userId).eq('confirmation_status', 'confirmed').gte('confirmed_at', start).lt('confirmed_at', end),
    supabase.from('orders').select('id, reference, customer_name, postponed_until').eq('assigned_to', userId).eq('confirmation_status', 'postponed')
      .in('delivery_status', ['not_submitted', 'submission_failed']).order('postponed_until', { ascending: true }).limit(6),
  ]);
  const pct = capacity ? Math.min(100, Math.round(((active ?? 0) / capacity) * 100)) : 0;
  return (
    <div className="grid gap-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <StatCard label={t('dashboard.myConfirmed')} value={formatNumber(myConfirmed ?? 0, locale)} icon={<CheckCircle2 />} tone="positive" href="/orders?view=confirmed" />
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Clock className="size-4 text-primary" />{t('dashboard.myReminders')}</CardTitle></CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          {(reminders ?? []).map((r) => {
            const late = r.postponed_until && Date.parse(r.postponed_until) <= Date.now();
            return (
              <Link key={r.id} href={`/orders/${r.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted">
                <span><span className="font-medium text-primary">#{r.reference}</span> {r.customer_name}</span>
                <span className={late ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}>{late ? '⏰ ' : ''}{r.postponed_until ? formatDateTime(r.postponed_until, locale) : '—'}</span>
              </Link>
            );
          })}
          {!reminders?.length ? <p className="text-muted-foreground">{t('dashboard.noReminders')}</p> : null}
        </CardContent>
      </Card>
    </div>
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader><CardTitle>{t('dashboard.myWorkload')}</CardTitle></CardHeader>
        <CardContent>
          <div className="tabular text-3xl font-semibold">{active ?? 0}<span className="text-base text-muted-foreground"> / {capacity}</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('dashboard.capacity')}: {pct}%</p>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>{t('dashboard.followUp')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TBody>
              {(followUps ?? []).map((o) => (
                <TR key={o.id}>
                  <TD><Link className="font-medium text-primary hover:underline" href={`/orders/${o.id}`}>#{o.reference}</Link></TD>
                  <TD>{o.customer_name}</TD>
                  <TD dir="ltr" className="tabular">{o.phone}</TD>
                  <TD><ConfirmationBadge status={o.confirmation_status as ConfirmationStatus} /></TD>
                </TR>
              ))}
              {!followUps?.length ? <TR><TD className="text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
    </div>
  );
}

async function TeamPerformance({ from, to, locale }: { from: string; to: string; locale: AppLocale }) {
  const t = await getTranslations();
  const rows = await rpc<{ agent_id: string; full_name: string; is_active: boolean; current_workload: number; max_active_orders: number; assigned: number; confirmed: number; cancelled: number; confirmation_rate: number | null }[]>(
    'agent_performance', { p_from: from, p_to: to },
  );
  return (
    <Card>
      <CardHeader><CardTitle>{t('dashboard.teamPerformance')}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <THead><TR><TH>{t('common.name')}</TH><TH>{t('team.workload')}</TH><TH>{t('team.assigned')}</TH><TH>{t('team.confirmed')}</TH><TH>{t('team.rate')}</TH></TR></THead>
          <TBody>
            {rows.filter((r) => r.is_active).map((r) => (
              <TR key={r.agent_id}>
                <TD className="font-medium">{r.full_name}</TD>
                <TD className="tabular">{r.current_workload} / {r.max_active_orders}</TD>
                <TD className="tabular">{formatNumber(r.assigned, locale)}</TD>
                <TD className="tabular">{formatNumber(r.confirmed, locale)}</TD>
                <TD className="tabular">{formatPercent(r.confirmation_rate, locale)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

async function TopProducts({ from, to, locale }: { from: string; to: string; locale: AppLocale }) {
  const t = await getTranslations();
  const rows = await rpc<{ product_id: string | null; product_name: string; orders: number; confirmed: number; delivered: number; distributed: number; returned: number; revenue: number }[]>(
    'product_operational_stats', { p_from: from, p_to: to },
  );
  const top = [...rows].sort((a, b) => b.orders - a.orders).slice(0, 8);
  return (
    <Card>
      <CardHeader><CardTitle>{t('dashboard.topProducts')}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <THead><TR><TH>{t('orders.product')}</TH><TH>{t('analytics.orders')}</TH><TH>{t('analytics.confirmed')}</TH><TH>{t('analytics.delivered')}</TH><TH>{t('analytics.returned')}</TH></TR></THead>
          <TBody>
            {top.map((r) => (
              <TR key={r.product_id ?? r.product_name}>
                <TD className="font-medium">{r.product_name}</TD>
                <TD className="tabular">{formatNumber(r.orders, locale)}</TD>
                <TD className="tabular">{formatNumber(r.confirmed, locale)}</TD>
                <TD className="tabular">{formatNumber(Number(r.delivered) + Number(r.distributed), locale)}</TD>
                <TD className="tabular">{formatNumber(r.returned, locale)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

async function FinancialPanel({ from, to, locale }: { from: string; to: string; locale: AppLocale }) {
  const t = await getTranslations();
  const s = await rpc<FinancialSummary>('financial_summary', { p_from: from, p_to: to });
  const d = s.delivered_totals;
  const tone = (n: number) => (n > 0 ? 'positive' : n < 0 ? 'negative' : 'default') as 'positive' | 'negative' | 'default';
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('dashboard.financial')}</CardTitle>
        <Link href="/finance" className="text-sm text-primary hover:underline">{t('nav.finance')} →</Link>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label={t('dashboard.revenue')} value={formatDZD(Number(d.product_revenue) + Number(d.delivery_fees_charged), locale)} />
        <StatCard label={t('dashboard.productCost')} value={formatDZD(d.product_cost, locale)} />
        <StatCard label={t('dashboard.deliveryCost')} value={formatDZD(d.delivery_cost, locale)} />
        <StatCard label={t('dashboard.adSpend')} value={formatDZD(s.ads.total_dzd, locale)} />
        <StatCard label={t('dashboard.otherExpenses')} value={formatDZD(s.expenses.overhead, locale)} />
        <StatCard label={t('dashboard.grossProfit')} value={formatDZD(s.profit.gross_delivered, locale)} tone={tone(s.profit.gross_delivered)} />
        <StatCard label={t('dashboard.netProfit')} value={formatDZD(s.profit.net_delivered_estimate, locale)} tone={tone(s.profit.net_delivered_estimate)} hint={t('common.estimated')} />
        <StatCard label={t('dashboard.potentialProfit')} value={formatDZD(s.profit.potential, locale)} hint={t('finance.potentialHelp')} />
        <StatCard label={t('dashboard.expectedProfit')} value={formatDZD(s.profit.expected, locale)} hint={t('finance.expectedHelp')} />
        <StatCard label={t('dashboard.realizedProfit')} value={formatDZD(s.profit.net_realized, locale)} tone={tone(s.profit.net_realized)} hint={t('finance.realizedHelp')} />
      </CardContent>
    </Card>
  );
}
