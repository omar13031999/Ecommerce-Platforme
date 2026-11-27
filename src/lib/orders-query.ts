import { escapeFilter } from '@/lib/utils';
import { resolveRange, rangeToInstants, type DateRange } from '@/lib/dates';
import { CLOSED_STATUSES, IN_TRANSIT_STATUSES, TO_PROCESS_STATUSES, isConfirmationStatus, isDeliveryStatus } from '@/lib/domain/statuses';

export type OrderSearchParams = {
  q?: string; status?: string; delivery?: string; agent?: string; wilaya?: string; product?: string;
  range?: string; from?: string; to?: string; review?: string; queue?: string; unmatched?: string;
  page?: string; size?: string; sort?: string; dir?: string;
  /** 'tracking': orders handed to a delivery company; default: orders still to process. */
  view?: string;
  /** Total to collect between tmin and tmax (DZD). */
  tmin?: string; tmax?: string;
  /** Delivery type: home | stopdesk. */
  dt?: string;
  /** UTM source contains. */
  utm?: string;
  /** '1': only blacklisted numbers. */
  blocked?: string;
};

export const SORTABLE = ['ordered_at', 'reference', 'total_amount', 'confirmation_status', 'delivery_status', 'updated_at'] as const;
/** Orders still handled by the confirmation team (not yet with a delivery company). */
export const TO_PROCESS_DELIVERY = ['not_submitted', 'submission_failed', 'pending_submission'];
/**
 * List tabs:
 *  process   — still worked by confirmers: new, no answer, unreachable, postponed (not sent)
 *  confirmed — confirmed, waiting to be sent to the delivery company
 *  tracking  — handed to a delivery company
 *  closed    — cancelled / duplicates (out of the working list)
 *  all       — no restriction
 */
export const ORDER_VIEWS = ['process', 'confirmed', 'tracking', 'closed', 'all'] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];
export function viewRule(view: OrderView): { status?: string[]; delivery?: string[]; notDelivery?: string[] } {
  switch (view) {
    case 'process': return { status: [...TO_PROCESS_STATUSES], delivery: TO_PROCESS_DELIVERY };
    case 'confirmed': return { status: ['confirmed'], delivery: TO_PROCESS_DELIVERY };
    case 'tracking': return { notDelivery: TO_PROCESS_DELIVERY };
    case 'closed': return { status: [...CLOSED_STATUSES] };
    default: return {};
  }
}
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
  // Tabs: an explicit status / delivery filter replaces that part of the tab's rule.
  // Without an explicit tab, a status/delivery filter (dashboard links…) searches every order.
  const view = ORDER_VIEWS.includes(sp.view as OrderView) ? (sp.view as OrderView) : sp.status || sp.delivery ? 'all' : 'process';
  const rule = viewRule(view);
  if (rule.status && !sp.status) q = q.in('confirmation_status', rule.status);
  if (rule.delivery && !sp.delivery) q = q.in('delivery_status', rule.delivery);
  if (rule.notDelivery && !sp.delivery) q = q.not('delivery_status', 'in', `(${rule.notDelivery.join(',')})`);
  if (sp.delivery) {
    if (sp.delivery === 'in_transit') q = q.in('delivery_status', IN_TRANSIT_STATUSES as string[]);
    else if (sp.delivery === 'not_submitted') q = q.in('delivery_status', ['not_submitted', 'submission_failed']);
    else if (isDeliveryStatus(sp.delivery)) q = q.eq('delivery_status', sp.delivery);
  }
  if (sp.agent === 'none') q = q.is('assigned_to', null);
  else if (sp.agent && /^[0-9a-f-]{36}$/i.test(sp.agent)) q = q.eq('assigned_to', sp.agent);
  if (sp.wilaya && /^\d{1,2}$/.test(sp.wilaya)) q = q.eq('wilaya_code', Number(sp.wilaya));
  if (sp.product && /^[0-9a-f-]{36}$/i.test(sp.product)) q = q.eq('filter_items.product_id', sp.product);
  if (sp.tmin && /^\d+(\.\d+)?$/.test(sp.tmin)) q = q.gte('total_amount', Number(sp.tmin));
  if (sp.tmax && /^\d+(\.\d+)?$/.test(sp.tmax)) q = q.lte('total_amount', Number(sp.tmax));
  if (sp.dt === 'home' || sp.dt === 'stopdesk') q = q.eq('delivery_type', sp.dt);
  if (sp.utm?.trim()) q = q.ilike('utm_source', `%${sp.utm.trim().replace(/[%_\\]/g, '').slice(0, 60)}%`);
  if (sp.blocked === '1') q = q.eq('customer_blocked', true);
  if (sp.review === '1') q = q.eq('needs_review', true);
  if (sp.unmatched === '1') q = q.eq('has_unmatched_items', true);
  if (sp.queue === 'waiting') q = q.is('assigned_to', null).in('confirmation_status', workloadStatuses);
  return { query: q, range };
}

export function orderSelect(sp: OrderSearchParams) {
  const base =
    'id, reference, external_id, source, customer_name, phone, wilaya_code, commune, total_amount, confirmation_status, delivery_status, ' +
    'assigned_to, ordered_at, updated_at, version, postponed_until, tracking_number, delivery_type, utm_source, customer_blocked, needs_review, has_unmatched_items, possible_duplicate_of, contact_attempts, ' +
    'order_items(product_name, quantity)';
  return sp.product ? `${base}, filter_items:order_items!inner(product_id)` : base;
}

export function sortOf(sp: OrderSearchParams) {
  const col = (SORTABLE as readonly string[]).includes(sp.sort ?? '') ? sp.sort! : 'ordered_at';
  return { col, ascending: sp.dir === 'asc' };
}
