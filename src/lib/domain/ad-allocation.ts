/**
 * Advertising cost allocation to products.
 *
 * 1. ATTRIBUTED (actual): spend of campaigns that can be linked to products —
 *    through orders carrying meta_campaign_id / meta_ad_id, or an explicit
 *    campaign→product mapping — is split across those products pro rata to the
 *    linked orders' revenue.
 * 2. ESTIMATED: the remaining (unattributed) spend is allocated with the
 *    method chosen by the owner: equal / distributed orders / revenue / manual.
 *
 * Total allocated never exceeds actual spend: no double counting.
 */
export type AllocationMethod = 'equal' | 'distributed' | 'revenue' | 'manual';

export type CampaignSpend = { campaign_id: string | null; spend_dzd: number };
export type ProductStat = { product_id: string; orders: number; distributed: number; revenue: number };
export type OrderLink = { campaign_id: string; product_id: string; revenue: number };

export type Allocation = { product_id: string; attributed: number; estimated: number };

export function allocateAdSpend(input: {
  campaigns: CampaignSpend[];
  products: ProductStat[];
  orderLinks: OrderLink[];
  campaignProducts: { campaign_id: string; product_id: string }[];
  method: AllocationMethod;
  manual?: { product_id: string; amount: number }[];
  useAttribution?: boolean;
}): { allocations: Allocation[]; unallocated: number; totalSpend: number } {
  const result = new Map<string, Allocation>();
  const slot = (id: string) => {
    let a = result.get(id);
    if (!a) result.set(id, (a = { product_id: id, attributed: 0, estimated: 0 }));
    return a;
  };
  const round = (n: number) => Math.round(n * 100) / 100;
  let unattributed = 0;
  const totalSpend = input.campaigns.reduce((s, c) => s + Math.max(0, c.spend_dzd), 0);

  for (const c of input.campaigns) {
    const spend = Math.max(0, c.spend_dzd);
    if (!spend) continue;
    if (input.useAttribution === false || !c.campaign_id) {
      unattributed += spend;
      continue;
    }
    const links = input.orderLinks.filter((l) => l.campaign_id === c.campaign_id);
    if (links.length) {
      const byProduct = new Map<string, number>();
      for (const l of links) byProduct.set(l.product_id, (byProduct.get(l.product_id) ?? 0) + Math.max(l.revenue, 0));
      const total = [...byProduct.values()].reduce((s, v) => s + v, 0);
      for (const [pid, rev] of byProduct) slot(pid).attributed += total > 0 ? (spend * rev) / total : spend / byProduct.size;
      continue;
    }
    const mapped = input.campaignProducts.filter((m) => m.campaign_id === c.campaign_id);
    if (mapped.length) {
      for (const m of mapped) slot(m.product_id).attributed += spend / mapped.length;
      continue;
    }
    unattributed += spend;
  }

  let remaining = unattributed;
  if (unattributed > 0) {
    if (input.method === 'manual') {
      const manualTotal = (input.manual ?? []).reduce((s, m) => s + m.amount, 0);
      const factor = manualTotal > unattributed ? unattributed / manualTotal : 1; // never exceed real spend
      for (const m of input.manual ?? []) slot(m.product_id).estimated += m.amount * factor;
      remaining = unattributed - Math.min(manualTotal, unattributed);
    } else {
      const weight = (p: ProductStat) => (input.method === 'equal' ? (p.orders > 0 ? 1 : 0) : input.method === 'distributed' ? p.distributed : p.revenue);
      const eligible = input.products.filter((p) => weight(p) > 0);
      const total = eligible.reduce((s, p) => s + weight(p), 0);
      if (total > 0) {
        for (const p of eligible) slot(p.product_id).estimated += (unattributed * weight(p)) / total;
        remaining = 0;
      }
    }
  }

  const allocations = [...result.values()].map((a) => ({ ...a, attributed: round(a.attributed), estimated: round(a.estimated) }));
  return { allocations, unallocated: round(Math.max(0, remaining)), totalSpend: round(totalSpend) };
}
