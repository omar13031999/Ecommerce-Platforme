import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { rangeToInstants } from '@/lib/dates';
import { allocateAdSpend, type AllocationMethod } from '@/lib/domain/ad-allocation';
import { fromDbError } from '@/lib/errors';

export type ProductRow = {
  product_id: string | null; product_name: string; has_purchase_cost: boolean | null;
  orders: number; quantity: number; confirmed: number; cancelled: number; distributed: number; delivered: number; returned: number;
  revenue: number; product_cost: number; delivery_cost: number; operational_cost: number; return_losses: number;
  gross_profit: number; incomplete_orders: number;
  ad_attributed: number; ad_estimated: number; net_profit: number;
  confirmation_rate: number | null; delivery_rate: number | null; return_rate: number | null;
  flags: ('high_performer' | 'low_profit' | 'negative_profit' | 'high_returns' | 'missing_cost')[];
};

const n = (v: unknown) => Number(v ?? 0);

/** Product profitability with advertising allocation (finance.view; RLS-scoped). */
export async function productIntelligence(from: string, to: string) {
  const supabase = await createClient();
  const { start, end } = rangeToInstants({ from, to });
  const [stats, spend, links, mapping, manual, setting] = await Promise.all([
    supabase.rpc('product_financial_stats', { p_from: from, p_to: to }),
    supabase.from('ad_spend_daily').select('campaign_id, spend_dzd').gte('date', from).lte('date', to),
    supabase.from('order_items').select('product_id, line_total, orders!inner(meta_campaign_id, ordered_at)')
      .not('orders.meta_campaign_id', 'is', null).gte('orders.ordered_at', start).lt('orders.ordered_at', end).not('product_id', 'is', null),
    supabase.from('ad_campaign_products').select('campaign_id, product_id'),
    supabase.from('ad_manual_allocations').select('product_id, amount_dzd, period_start, period_end').lte('period_start', to).gte('period_end', from),
    supabase.from('app_settings').select('value').eq('key', 'ads_allocation').maybeSingle(),
  ]);
  if (stats.error) throw fromDbError(stats.error);

  const byCampaign = new Map<string | null, number>();
  for (const r of spend.data ?? []) byCampaign.set(r.campaign_id, (byCampaign.get(r.campaign_id) ?? 0) + n(r.spend_dzd));
  const cfg = (setting.data?.value ?? {}) as { use_attribution?: boolean; fallback_method?: AllocationMethod };
  const raw = (stats.data ?? []) as Omit<ProductRow, 'ad_attributed' | 'ad_estimated' | 'net_profit' | 'flags' | 'confirmation_rate' | 'delivery_rate' | 'return_rate'>[];

  const alloc = allocateAdSpend({
    campaigns: [...byCampaign.entries()].map(([campaign_id, spend_dzd]) => ({ campaign_id, spend_dzd })),
    products: raw.filter((r) => r.product_id).map((r) => ({ product_id: r.product_id!, orders: n(r.orders), distributed: n(r.distributed) + n(r.delivered), revenue: n(r.revenue) })),
    orderLinks: (links.data ?? []).map((l) => ({
      campaign_id: (l.orders as unknown as { meta_campaign_id: string }).meta_campaign_id, product_id: l.product_id as string, revenue: n(l.line_total),
    })),
    campaignProducts: mapping.data ?? [],
    method: cfg.fallback_method ?? 'distributed',
    useAttribution: cfg.use_attribution !== false,
    manual: (manual.data ?? []).map((m) => ({ product_id: m.product_id, amount: n(m.amount_dzd) })),
  });
  const allocBy = new Map(alloc.allocations.map((a) => [a.product_id, a]));

  const rows: ProductRow[] = raw.map((r) => {
    const a = r.product_id ? allocBy.get(r.product_id) : undefined;
    const adA = a?.attributed ?? 0;
    const adE = a?.estimated ?? 0;
    const net = n(r.gross_profit) - adA - adE;
    const finished = n(r.distributed) + n(r.delivered) + n(r.returned);
    const decided = n(r.orders);
    const row: ProductRow = {
      ...r,
      orders: n(r.orders), quantity: n(r.quantity), confirmed: n(r.confirmed), cancelled: n(r.cancelled), distributed: n(r.distributed),
      delivered: n(r.delivered), returned: n(r.returned), revenue: n(r.revenue), product_cost: n(r.product_cost), delivery_cost: n(r.delivery_cost),
      operational_cost: n(r.operational_cost), return_losses: n(r.return_losses), gross_profit: n(r.gross_profit), incomplete_orders: n(r.incomplete_orders),
      ad_attributed: adA, ad_estimated: adE, net_profit: net,
      confirmation_rate: decided ? n(r.confirmed) / decided : null,
      delivery_rate: finished ? (n(r.distributed) + n(r.delivered)) / finished : null,
      return_rate: finished ? n(r.returned) / finished : null,
      flags: [],
    };
    const margin = row.revenue > 0 ? net / row.revenue : null;
    if (!r.has_purchase_cost || row.incomplete_orders > 0) row.flags.push('missing_cost');
    if (net < 0) row.flags.push('negative_profit');
    else if (margin !== null && margin < 0.1) row.flags.push('low_profit');
    if (margin !== null && margin >= 0.25 && row.distributed + row.delivered >= 5) row.flags.push('high_performer');
    if (row.return_rate !== null && row.return_rate >= 0.25 && finished >= 4) row.flags.push('high_returns');
    return row;
  });
  rows.sort((a, b) => b.net_profit - a.net_profit);
  return { rows, unallocated: alloc.unallocated, totalSpend: alloc.totalSpend, method: cfg.fallback_method ?? 'distributed' };
}
