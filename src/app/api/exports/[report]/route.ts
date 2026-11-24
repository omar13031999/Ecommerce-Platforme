import { NextResponse } from 'next/server';
import { getTranslations, getLocale } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import type { Permission } from '@/lib/auth/permissions';
import { applyOrderFilters, type OrderSearchParams } from '@/lib/orders-query';
import { resolveRange } from '@/lib/dates';
import { toCsv, toXlsx, type Column } from '@/lib/services/export';
import { productIntelligence } from '@/lib/services/analytics';
import { isConfirmationStatus, isDeliveryStatus } from '@/lib/domain/statuses';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const REPORTS: Record<string, Permission> = {
  orders: 'orders.export', products: 'finance.view', daily: 'finance.view', expenses: 'finance.view', settlements: 'finance.view', profit: 'finance.view',
};
const MONEY = '#,##0.00';

/**
 * Secure exports: permission checked here AND every query runs as the user
 * (RLS), so an export can never contain more than the user may see.
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const perm = REPORTS[report];
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!perm || !session.can(perm)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const sp = Object.fromEntries(url.searchParams.entries()) as OrderSearchParams & { format?: string };
  const format = sp.format === 'csv' ? 'csv' : 'xlsx';
  const range = resolveRange({ range: sp.from ? 'custom' : sp.range, from: sp.from, to: sp.to }, 'this_month');
  const t = await getTranslations();
  const locale = await getLocale();
  const supabase = await createClient();
  let columns: Column[] = [];
  let rows: Record<string, unknown>[] = [];

  if (report === 'orders') {
    const { data: ws } = await supabase.rpc('workload_statuses');
    const { query } = applyOrderFilters(
      supabase.from('orders').select('reference, external_id, ordered_at, customer_name, phone, phone2, wilaya_code, commune, address, delivery_type, subtotal, delivery_fee, discount, total_amount, confirmation_status, delivery_status, tracking_number, assigned_to, source, order_items(product_name, quantity, unit_price)' + (sp.product ? ', filter_items:order_items!inner(product_id)' : '')),
      sp, (ws ?? ['new']) as string[]);
    const { data } = await query.order('ordered_at', { ascending: false }).limit(20000);
    const { data: staff } = await supabase.from('staff_directory').select('id, full_name');
    const names = Object.fromEntries((staff ?? []).map((s) => [s.id, s.full_name]));
    columns = [
      { key: 'reference', header: t('orders.reference'), width: 10 }, { key: 'external_id', header: t('orders.externalId') },
      { key: 'ordered_at', header: t('orders.createdAt'), width: 20 }, { key: 'customer_name', header: t('orders.customerName'), width: 24 },
      { key: 'phone', header: t('orders.phone') }, { key: 'phone2', header: t('orders.phone2') }, { key: 'wilaya_code', header: t('orders.wilaya'), width: 8 },
      { key: 'commune', header: t('orders.commune') }, { key: 'address', header: t('orders.address'), width: 30 }, { key: 'products', header: t('orders.products'), width: 40 },
      { key: 'subtotal', header: t('orders.subtotal'), numFmt: MONEY }, { key: 'delivery_fee', header: t('orders.deliveryFee'), numFmt: MONEY },
      { key: 'discount', header: t('orders.discount'), numFmt: MONEY }, { key: 'total_amount', header: t('orders.totalAmount'), numFmt: MONEY },
      { key: 'confirmation', header: t('orders.confirmationStatus') }, { key: 'delivery', header: t('orders.deliveryStatus') },
      { key: 'tracking_number', header: t('orders.tracking') }, { key: 'agent', header: t('orders.assignedTo') }, { key: 'source', header: t('orders.source') },
    ];
    rows = ((data ?? []) as unknown as Record<string, unknown>[]).map((o) => ({
      ...o,
      ordered_at: new Date(String(o.ordered_at)).toLocaleString(locale === 'ar' ? 'ar-DZ-u-nu-latn' : 'fr-DZ', { timeZone: 'Africa/Algiers' }),
      products: ((o.order_items ?? []) as { product_name: string; quantity: number }[]).map((i) => `${i.product_name} x${i.quantity}`).join(' | '),
      subtotal: Number(o.subtotal), delivery_fee: Number(o.delivery_fee), discount: Number(o.discount), total_amount: Number(o.total_amount),
      confirmation: isConfirmationStatus(String(o.confirmation_status)) ? t(`confirmation.${o.confirmation_status as 'new'}`) : o.confirmation_status,
      delivery: isDeliveryStatus(String(o.delivery_status)) ? t(`delivery.${o.delivery_status as 'delivered'}`) : o.delivery_status,
      agent: o.assigned_to ? names[String(o.assigned_to)] ?? '' : '',
    }));
  } else if (report === 'products') {
    const { rows: list } = await productIntelligence(range.from, range.to);
    columns = [
      { key: 'product_name', header: t('orders.product'), width: 28 }, { key: 'orders', header: t('analytics.orders') }, { key: 'quantity', header: t('analytics.quantity') },
      { key: 'confirmed', header: t('analytics.confirmed') }, { key: 'cancelled', header: t('analytics.cancelled') }, { key: 'distributed', header: t('analytics.distributed') },
      { key: 'delivered', header: t('analytics.delivered') }, { key: 'returned', header: t('analytics.returned') }, { key: 'revenue', header: t('analytics.revenue'), numFmt: MONEY },
      { key: 'product_cost', header: t('analytics.productCost'), numFmt: MONEY }, { key: 'delivery_cost', header: t('analytics.deliveryCost'), numFmt: MONEY },
      { key: 'operational_cost', header: t('finance.operationalCost'), numFmt: MONEY }, { key: 'return_losses', header: t('finance.returnedLosses'), numFmt: MONEY },
      { key: 'ad_attributed', header: `${t('analytics.adCost')} (${t('analytics.adAttributed')})`, numFmt: MONEY },
      { key: 'ad_estimated', header: `${t('analytics.adCost')} (${t('analytics.adEstimated')})`, numFmt: MONEY },
      { key: 'net_profit', header: t('analytics.netProfit'), numFmt: MONEY }, { key: 'incomplete_orders', header: t('products.missingCost') },
    ];
    rows = list as unknown as Record<string, unknown>[];
  } else if (report === 'daily') {
    const { data } = await supabase.rpc('profit_timeseries', { p_from: range.from, p_to: range.to });
    columns = [
      { key: 'day', header: t('common.date'), width: 12 }, { key: 'product_revenue', header: t('finance.productRevenue'), numFmt: MONEY },
      { key: 'gross_profit', header: t('finance.grossProfit'), numFmt: MONEY }, { key: 'returned_losses', header: t('finance.returnedLosses'), numFmt: MONEY },
      { key: 'ad_spend', header: t('finance.adSpend'), numFmt: MONEY }, { key: 'expenses', header: t('finance.overhead'), numFmt: MONEY },
      { key: 'net_profit', header: t('finance.netProfit'), numFmt: MONEY },
    ];
    rows = ((data ?? []) as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'day' ? v : Number(v)])));
  } else if (report === 'profit') {
    const { data } = await supabase.from('order_profit').select('reference, period_date, bucket, product_revenue, delivery_fee_charged, product_cost, delivery_cost, delivery_cost_estimated, operational_cost, gross_profit, profit_incomplete')
      .gte('period_date', range.from).lte('period_date', range.to).not('bucket', 'in', '(not_confirmed,cancelled)').limit(50000);
    columns = [
      { key: 'reference', header: t('orders.reference') }, { key: 'period_date', header: t('common.date') }, { key: 'bucket', header: t('finance.bucket') },
      { key: 'product_revenue', header: t('finance.productRevenue'), numFmt: MONEY }, { key: 'delivery_fee_charged', header: t('finance.deliveryFeesCharged'), numFmt: MONEY },
      { key: 'product_cost', header: t('finance.productCost'), numFmt: MONEY }, { key: 'delivery_cost', header: t('finance.deliveryCost'), numFmt: MONEY },
      { key: 'estimated', header: t('common.estimated') }, { key: 'operational_cost', header: t('finance.operationalCost'), numFmt: MONEY },
      { key: 'gross_profit', header: t('finance.grossProfit'), numFmt: MONEY },
    ];
    rows = (data ?? []).map((r) => ({ ...r, bucket: t(`finance.bucket_${r.bucket}` as 'finance.bucket_realized'), estimated: r.delivery_cost_estimated ? t('common.yes') : t('common.no'), gross_profit: r.profit_incomplete ? null : r.gross_profit }));
  } else if (report === 'expenses') {
    const { data } = await supabase.from('expenses').select('expense_date, title, amount, amount_paid, payment_status, payment_method, payee, reference, description, expense_categories(name, kind, profit_treatment)')
      .gte('expense_date', range.from).lte('expense_date', range.to).order('expense_date').limit(50000);
    columns = [
      { key: 'expense_date', header: t('common.date') }, { key: 'title', header: t('expenses.titleField'), width: 28 }, { key: 'category', header: t('common.category'), width: 22 },
      { key: 'amount', header: t('expenses.amountDzd'), numFmt: MONEY }, { key: 'amount_paid', header: t('expenses.amountPaid'), numFmt: MONEY },
      { key: 'status', header: t('expenses.paymentStatus') }, { key: 'treatment', header: t('expenses.treatment') }, { key: 'payment_method', header: t('expenses.paymentMethod') },
      { key: 'payee', header: t('expenses.payee') }, { key: 'reference', header: t('expenses.reference') }, { key: 'description', header: t('common.description'), width: 30 },
    ];
    rows = (data ?? []).map((e) => {
      const c = e.expense_categories as unknown as { name: string; profit_treatment: 'deduct' } | null;
      return { ...e, amount: Number(e.amount), amount_paid: Number(e.amount_paid), category: c?.name, treatment: c ? t(`expenses.${c.profit_treatment}`) : '', status: t(`expenses.${e.payment_status as 'paid'}`) };
    });
  } else if (report === 'settlements') {
    const { data } = await supabase.from('cod_settlements').select('expected_amount, collected_amount, provider_fees, transferred_amount, transfer_date, payment_reference, batch_reference, status, orders(reference, tracking_number, delivered_at)').limit(50000);
    columns = [
      { key: 'reference', header: t('orders.reference') }, { key: 'tracking', header: t('orders.tracking') }, { key: 'expected_amount', header: t('reconciliation.expected'), numFmt: MONEY },
      { key: 'collected_amount', header: t('reconciliation.collected'), numFmt: MONEY }, { key: 'provider_fees', header: t('reconciliation.providerFees'), numFmt: MONEY },
      { key: 'transferred_amount', header: t('reconciliation.transferred'), numFmt: MONEY }, { key: 'outstanding', header: t('reconciliation.outstanding'), numFmt: MONEY },
      { key: 'transfer_date', header: t('reconciliation.transferDate') }, { key: 'payment_reference', header: t('reconciliation.paymentReference') }, { key: 'status', header: t('common.status') },
    ];
    rows = (data ?? []).map((s) => {
      const o = s.orders as unknown as { reference: number; tracking_number: string | null } | null;
      return { ...s, reference: o?.reference, tracking: o?.tracking_number, outstanding: Number(s.collected_amount ?? s.expected_amount) - Number(s.provider_fees ?? 0) - Number(s.transferred_amount ?? 0) };
    });
  }

  const filename = `${report}-${range.from}_${range.to}.${format}`;
  if (format === 'csv') {
    return new NextResponse(toCsv(columns, rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
  }
  const buf = await toXlsx(report, columns, rows, locale === 'ar');
  return new NextResponse(new Uint8Array(buf), {
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
  });
}
