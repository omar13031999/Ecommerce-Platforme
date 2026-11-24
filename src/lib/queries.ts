import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { fromDbError } from '@/lib/errors';

/** Thin typed wrapper around RPC calls executed AS THE USER (RLS applies). */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error);
  return data as T;
}

export type OperationalDashboard = {
  counts: Record<
    'total' | 'new' | 'awaiting_confirmation' | 'no_answer' | 'unreachable' | 'confirmed' | 'cancelled' | 'duplicate' |
    'awaiting_delivery' | 'in_transit' | 'distributed' | 'delivered' | 'returned' | 'failed_delivery' | 'needs_review' | 'unassigned',
    number
  >;
  confirmation_rate: number | null;
  delivery_success_rate: number | null;
  return_rate: number | null;
};

type Bucket = { orders: number; product_revenue: number; delivery_fees_charged: number; product_cost: number; delivery_cost: number; operational_cost: number; gross_profit: number; incomplete_orders: number; estimated_delivery_cost_orders: number };
export type FinancialSummary = {
  buckets: Partial<Record<'potential' | 'in_delivery' | 'delivered_unsettled' | 'realized' | 'returned', Bucket>>;
  delivered_totals: { product_revenue: number; delivery_fees_charged: number; product_cost: number; delivery_cost: number; operational_cost: number };
  ads: { meta_spend_dzd: number; rows_missing_fx: number; advertising_expenses: number | string; total_dzd: number };
  expenses: { advertising_expenses: number; overhead: number; informational: number; by_kind: Record<string, number> };
  profit: { potential: number; expected: number; realized_gross: number; returned_losses: number; gross_delivered: number; net_realized: number; net_delivered_estimate: number; net_pipeline_estimate: number };
  warnings: string[];
};
