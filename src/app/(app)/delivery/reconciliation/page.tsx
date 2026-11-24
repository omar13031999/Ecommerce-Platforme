import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { StatCard } from '@/components/app/stat-card';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDZD, formatDate, type AppLocale } from '@/lib/format';
import { SettlementEditor, SettlementImport } from './reconciliation-client';

const STATUS = ['pending', 'collected', 'partially_transferred', 'transferred', 'discrepancy', 'not_applicable'] as const;
const label: Record<string, string> = { pending: 'pending', collected: 'collectedStatus', partially_transferred: 'partially_transferred', transferred: 'transferredStatus', discrepancy: 'discrepancyStatus', not_applicable: 'not_applicable' };
const tone: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200', collected: 'bg-blue-50 text-blue-700 ring-blue-200',
  partially_transferred: 'bg-orange-50 text-orange-800 ring-orange-200', transferred: 'bg-green-50 text-green-700 ring-green-200',
  discrepancy: 'bg-red-50 text-red-700 ring-red-200', not_applicable: 'bg-zinc-100 text-zinc-600 ring-zinc-200',
};

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<{ status?: string; provider?: string }> }) {
  const session = await requirePage('finance.view');
  const sp = await searchParams;
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();

  let q = supabase.from('cod_settlements')
    .select('order_id, provider_id, expected_amount, collected_amount, provider_fees, transferred_amount, transfer_date, payment_reference, status, notes, orders(reference, customer_name, tracking_number, delivered_at)')
    .order('created_at', { ascending: false }).limit(300);
  if (sp.status && (STATUS as readonly string[]).includes(sp.status)) q = q.eq('status', sp.status);
  if (sp.provider) q = q.eq('provider_id', sp.provider);
  const [{ data: rows }, { data: all }, { data: providers }] = await Promise.all([
    q,
    supabase.from('cod_settlements').select('status, expected_amount, collected_amount, provider_fees, transferred_amount').neq('status', 'not_applicable'),
    supabase.from('delivery_providers').select('id, name'),
  ]);
  const sum = (k: 'expected_amount' | 'transferred_amount' | 'provider_fees') => (all ?? []).reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const expected = sum('expected_amount');
  const fees = sum('provider_fees');
  const transferred = sum('transferred_amount');
  const providerName = Object.fromEntries((providers ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="grid gap-5">
      <PageHeader title={t('reconciliation.title')} description={t('reconciliation.subtitle')} actions={session.can('finance.manage') ? <SettlementImport /> : null} />
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label={t('reconciliation.expected')} value={formatDZD(expected, locale)} />
        <StatCard label={t('reconciliation.providerFees')} value={formatDZD(fees, locale)} />
        <StatCard label={t('reconciliation.transferred')} value={formatDZD(transferred, locale)} tone="positive" />
        <StatCard label={t('reconciliation.outstanding')} value={formatDZD(expected - fees - transferred, locale)} tone="warning" />
      </div>
      <form className="flex flex-wrap gap-2">
        <Select name="status" defaultValue={sp.status ?? ''} className="w-56">
          <option value="">{t('common.status')}: {t('common.all')}</option>
          {STATUS.map((s) => <option key={s} value={s}>{t(`reconciliation.${label[s]}` as 'reconciliation.pending')}</option>)}
        </Select>
        <Select name="provider" defaultValue={sp.provider ?? ''} className="w-48">
          <option value="">{t('orders.provider')}: {t('common.all')}</option>
          {(providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <button className="h-9 rounded-md border bg-card px-3 text-sm hover:bg-accent">{t('common.apply')}</button>
        <a className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm hover:bg-accent" href="/api/exports/settlements?format=xlsx">{t('common.exportXlsx')}</a>
      </form>
      <Card className="overflow-hidden">
        <Table>
          <THead><TR>
            <TH>{t('orders.reference')}</TH><TH>{t('orders.tracking')}</TH><TH>{t('orders.provider')}</TH><TH>{t('reconciliation.expected')}</TH>
            <TH>{t('reconciliation.collected')}</TH><TH>{t('reconciliation.providerFees')}</TH><TH>{t('reconciliation.transferred')}</TH>
            <TH>{t('reconciliation.outstanding')}</TH><TH>{t('reconciliation.transferDate')}</TH><TH>{t('common.status')}</TH><TH />
          </TR></THead>
          <TBody>
            {(rows ?? []).map((r) => {
              const o = r.orders as unknown as { reference: number; customer_name: string; tracking_number: string | null } | null;
              const outstanding = Number(r.collected_amount ?? r.expected_amount) - Number(r.provider_fees ?? 0) - Number(r.transferred_amount ?? 0);
              return (
                <TR key={r.order_id}>
                  <TD><Link href={`/orders/${r.order_id}`} className="font-medium text-primary hover:underline">#{o?.reference}</Link><div className="text-xs text-muted-foreground">{o?.customer_name}</div></TD>
                  <TD className="font-mono text-xs">{o?.tracking_number ?? '—'}</TD>
                  <TD>{r.provider_id ? providerName[r.provider_id] : '—'}</TD>
                  <TD className="tabular">{formatDZD(r.expected_amount, locale)}</TD>
                  <TD className="tabular">{formatDZD(r.collected_amount, locale)}</TD>
                  <TD className="tabular">{formatDZD(r.provider_fees, locale)}</TD>
                  <TD className="tabular">{formatDZD(r.transferred_amount, locale)}</TD>
                  <TD className="tabular">{r.status === 'not_applicable' ? '—' : formatDZD(outstanding, locale)}</TD>
                  <TD className="text-xs">{formatDate(r.transfer_date, locale)}{r.payment_reference ? <div className="text-muted-foreground">{r.payment_reference}</div> : null}</TD>
                  <TD><Badge className={tone[r.status]}>{t(`reconciliation.${label[r.status]}` as 'reconciliation.pending')}</Badge></TD>
                  <TD>{session.can('finance.manage') ? <SettlementEditor row={{
                    orderId: r.order_id, collected_amount: r.collected_amount, provider_fees: r.provider_fees, transferred_amount: r.transferred_amount,
                    transfer_date: r.transfer_date, payment_reference: r.payment_reference, notes: r.notes, not_applicable: r.status === 'not_applicable',
                  }} /> : null}</TD>
                </TR>
              );
            })}
            {!rows?.length ? <TR><TD colSpan={11} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
