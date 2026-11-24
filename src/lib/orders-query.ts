import { escapeFilter } from '@/lib/utils';
import { resolveRange, rangeToInstants, type DateRange } from '@/lib/dates';
import { IN_TRANSIT_STATUSES, isConfirmationStatus, isDeliveryStatus } from '@/lib/domain/statuses';

export type OrderSearchParams = {
  q?: string; status?: string; delivery?: string; agent?: string; wilaya?: string; product?: string;
  range?: string; from?: string; to?: string; review?: string; queue?: string; unmatched?: string;
  page?: string; size?: string; sort?: string; dir?: string;
};

export const SORTABLE = ['ordered_at', 'reference', 'total_amount', 'confirmation_status', 'delivery_status', 'updated_at'] as const;
const NO_ANSWER = ['no_answer_1', 'no_answer_2', 'no_answer_3', 'no_answer_4', 'no_answer_5', 'no_answer_6', 'no_answer_7', 'no_answer_8', 'no_answer_9'];

/** Applies list filters to a PostgREST query builder (RLS still applies). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOrderFilters<Q extends { [k: string]: any }>(query: Q, sp: OrderSearchParams, workloadStatuses: string[]): { query: Q; range: DateRange | null } {
  let q = query;
  let range: DateRange | null = null;
  if (sp.range) {
    range = resolveRange(sp, 'last30');
    const { start, end } = rangeToInstants(range);
    q = q.gte('ordered_at', start).lt('ordered_at', end);
  }
  if (sp.q?.trim()) {
    const s = escapeFilter(sp.q.trim()).slice(0, 80);
    const ors = [`customer_name.ilike.*${s}*`, `phone.ilike.*${s}*`, `phone2.ilike.*${s}*`, `tracking_number.ilike.*${s}*`, `external_id.ilike.*${s}*`];
    if (/^\d{1,12}$/.test(s)) ors.push(`reference.eq.${s}`);
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 6) ors.push(`phone_normalized.ilike.*${digits.replace(/^213/, '')}*`);
    q = q.or(ors.join(','));
  }
  if (sp.status) {
    if (sp.status === 'active') q = q.in('confirmation_status', workloadStatuses);
    else if (sp.status === 'no_answer') q = q.in('confirmation_status', NO_ANSWER);
    else if (isConfirmationStatus(sp.status)) q = q.eq('confirmation_status', sp.status);
  }
  if (sp.delivery) {
    if (sp.delivery === 'in_transit') q = q.in('delivery_status', IN_TRANSIT_STATUSES as string[]);
    else if (sp.delivery === 'not_submitted') q = q.in('delivery_status', ['not_submitted', 'submission_failed']);
    else if (isDeliveryStatus(sp.delivery)) q = q.eq('delivery_status', sp.delivery);
  }
  if (sp.agent === 'none') q = q.is('assigned_to', null);
  else if (sp.agent && /^[0-9a-f-]{36}$/i.test(sp.agent)) q = q.eq('assigned_to', sp.agent);
  if (sp.wilaya && /^\d{1,2}$/.test(sp.wilaya)) q = q.eq('wilaya_code', Number(sp.wilaya));
  if (sp.product && /^[0-9a-f-]{36}$/i.test(sp.product)) q = q.eq('filter_items.product_id', sp.product);
  if (sp.review === '1') q = q.eq('needs_review', true);
  if (sp.unmatched === '1') q = q.eq('has_unmatched_items', true);
  if (sp.queue === 'waiting') q = q.is('assigned_to', null).in('confirmation_status', workloadStatuses);
  return { query: q, range };
}

export function orderSelect(sp: OrderSearchParams) {
  const base =
    'id, reference, external_id, source, customer_name, phone, wilaya_code, commune, total_amount, confirmation_status, delivery_status, ' +
    'assigned_to, ordered_at, updated_at, tracking_number, needs_review, has_unmatched_items, possible_duplicate_of, contact_attempts, ' +
    'order_items(product_name, quantity)';
  return sp.product ? `${base}, filter_items:order_items!inner(product_id)` : base;
}

export function sortOf(sp: OrderSearchParams) {
  const col = (SORTABLE as readonly string[]).includes(sp.sort ?? '') ? sp.sort! : 'ordered_at';
  return { col, ascending: sp.dir === 'asc' };
}
