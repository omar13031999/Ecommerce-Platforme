'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth/session';
import { AppError, fromDbError, runAction } from '@/lib/errors';
import { CONFIRMATION_STATUSES, DELIVERY_STATUSES } from '@/lib/domain/statuses';
import { submitOrders, type SubmitResult } from '@/lib/services/delivery';

const uuid = z.guid();
const uuids = z.array(uuid).min(1).max(500);
const note = z.string().trim().max(4000).optional().transform((v) => (v ? v : undefined));

/** Agent/manager status change. Authorization & transitions enforced in SQL. */
export async function changeConfirmationStatus(input: { orderId: string; status: string; note?: string; version?: number }) {
  return runAction(async () => {
    await requireUser();
    const p = z.object({ orderId: uuid, status: z.enum(CONFIRMATION_STATUSES), note, version: z.number().int().optional() }).parse(input);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('set_confirmation_status', {
      p_order_id: p.orderId, p_status: p.status, p_note: p.note ?? null, p_expected_version: p.version ?? null,
    });
    if (error) throw fromDbError(error);
    return data as { version: number; redistributed_to: string | null };
  });
}

export async function addOrderNote(input: { orderId: string; body: string }) {
  return runAction(async () => {
    const session = await requireUser();
    const p = z.object({ orderId: uuid, body: z.string().trim().min(1).max(4000) }).parse(input);
    const supabase = await createClient();
    const { error } = await supabase.from('order_notes').insert({ order_id: p.orderId, author_id: session.userId, body: p.body });
    if (error) throw fromDbError(error);
  });
}

const customerSchema = z.object({
  customer_name: z.string().trim().max(200),
  phone: z.string().trim().max(30).refine((v) => v === '' || v.replace(/\D/g, '').length >= 9, 'invalid_phone'),
  phone2: z.string().trim().max(30).optional().default(''),
  wilaya_code: z.coerce.number().int().min(1).max(58).nullable().optional(),
  commune: z.string().trim().max(120).optional().default(''),
  address: z.string().trim().max(500).optional().default(''),
  delivery_type: z.enum(['home', 'stopdesk']),
  customer_notes: z.string().trim().max(2000).optional(),
});

export async function updateOrderCustomer(input: { orderId: string; version?: number; patch: unknown }) {
  return runAction(async () => {
    await requireUser();
    const id = uuid.parse(input.orderId);
    const patch = customerSchema.safeParse(input.patch);
    if (!patch.success) throw new AppError('invalid_input', 400, patch.error.flatten().fieldErrors);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('update_order_customer', { p_order_id: id, p_patch: patch.data, p_expected_version: input.version ?? null });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

const itemsSchema = z.array(z.object({
  id: z.guid().optional(),
  product_id: z.guid().nullable().optional(),
  product_name: z.string().trim().max(300).optional(),
  quantity: z.coerce.number().int().min(1).max(10_000),
  unit_price: z.coerce.number().min(0).max(100_000_000),
})).min(1).max(50);

/** Replaces the product lines of an order (assigned agent or manager, before delivery). */
export async function updateOrderItems(input: { orderId: string; version?: number; items: unknown }) {
  return runAction(async () => {
    await requireUser();
    const id = uuid.parse(input.orderId);
    const items = itemsSchema.safeParse(input.items);
    if (!items.success) throw new AppError('invalid_items', 400);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('update_order_items', { p_order_id: id, p_items: items.data, p_expected_version: input.version ?? null });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

export async function assignOrders(input: { orderIds: string[]; agentId: string; force?: boolean; note?: string }) {
  return runAction(async () => {
    await requireUser('orders.assign');
    const p = z.object({ orderIds: uuids, agentId: uuid, force: z.boolean().default(false), note }).parse(input);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('manual_assign_orders', { p_order_ids: p.orderIds, p_agent_id: p.agentId, p_force: p.force, p_note: p.note ?? null });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

export async function autoAssignOrders(orderIds: string[]) {
  return runAction(async () => {
    await requireUser('orders.assign');
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('auto_assign_orders', { p_order_ids: uuids.parse(orderIds) });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

export async function unassignOrders(orderIds: string[]) {
  return runAction(async () => {
    await requireUser('orders.assign');
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('unassign_orders', { p_order_ids: uuids.parse(orderIds) });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

export async function resolveReview(input: { orderId: string; note?: string }) {
  return runAction(async () => {
    await requireUser('orders.manage');
    const supabase = await createClient();
    const { error } = await supabase.rpc('resolve_review', { p_order_id: uuid.parse(input.orderId), p_note: input.note ?? null });
    if (error) throw fromDbError(error);
  });
}

/** Bulk/single API submission. Permission checked here; the service uses the service role. */
export async function submitToDelivery(input: { orderIds: string[]; providerId: string }) {
  return runAction(async (): Promise<{ ok: number; failed: number; results: SubmitResult[] }> => {
    const session = await requireUser('delivery.manage');
    const p = z.object({ orderIds: uuids.max(200), providerId: uuid }).parse(input);
    const results = await submitOrders(p.orderIds, p.providerId, session.userId, 'manual');
    return { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  });
}

export async function setDeliveryManual(input: { orderId: string; status: string; tracking?: string; providerId?: string | null; note?: string }) {
  return runAction(async () => {
    await requireUser('delivery.manage');
    const p = z.object({
      orderId: uuid, status: z.enum(DELIVERY_STATUSES), tracking: z.string().trim().max(80).optional(),
      providerId: uuid.nullable().optional(), note,
    }).parse(input);
    const supabase = await createClient();
    const { error } = await supabase.rpc('set_delivery_status_manual', {
      p_order_id: p.orderId, p_status: p.status, p_tracking: p.tracking ?? null, p_provider_id: p.providerId ?? null, p_note: p.note ?? null,
    });
    if (error) throw fromDbError(error);
  });
}

const createSchema = z.object({
  customer_name: z.string().trim().min(1).max(200),
  phone: z.string().trim().regex(/^[+\d\s.-]{9,20}$/),
  phone2: z.string().trim().max(30).optional(),
  wilaya_code: z.coerce.number().int().min(1).max(58),
  commune: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).optional(),
  delivery_type: z.enum(['home', 'stopdesk']),
  customer_notes: z.string().trim().max(2000).optional(),
  delivery_fee: z.coerce.number().min(0).max(100000),
  discount: z.coerce.number().min(0).max(10000000).default(0),
  items: z.array(z.object({ product_id: uuid, quantity: z.coerce.number().int().min(1).max(1000), unit_price: z.coerce.number().min(0).max(10000000) })).min(1).max(50),
});
export type CreateOrderInput = z.input<typeof createSchema>;

export async function createOrder(input: CreateOrderInput) {
  return runAction(async () => {
    await requireUser('orders.create');
    const p = createSchema.safeParse(input);
    if (!p.success) throw new AppError('invalid_input', 400, p.error.flatten().fieldErrors);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('create_order', { p_order: p.data });
    if (error) throw fromDbError(error);
    return data as string;
  });
}

export async function matchOrderItem(input: { itemId: string; productId: string; remember: boolean }) {
  return runAction(async () => {
    await requireUser('products.manage', 'orders.manage');
    const p = z.object({ itemId: uuid, productId: uuid, remember: z.boolean() }).parse(input);
    const supabase = await createClient();
    const { error } = await supabase.rpc('match_order_item', { p_item_id: p.itemId, p_product_id: p.productId, p_remember: p.remember });
    if (error) throw fromDbError(error);
  });
}

/** Postpone: the customer asked to be called back at a given date/time (notification when due). */
export async function postponeOrder(input: { orderId: string; until: string; note?: string; version?: number }) {
  return runAction(async () => {
    await requireUser();
    const p = z.object({ orderId: uuid, until: z.string().datetime({ offset: true }), note, version: z.number().int().optional() }).parse(input);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('postpone_order', {
      p_order_id: p.orderId, p_until: p.until, p_note: p.note ?? null, p_expected_version: p.version ?? null,
    });
    if (error) throw fromDbError(error);
    return data as { version: number; postponed_until: string };
  });
}

/** Permanent deletion — owner (admin role) only; also enforced in the database. */
export async function deleteOrders(orderIds: string[]) {
  return runAction(async () => {
    const s = await requireUser();
    if (s.profile.role !== 'admin') throw new AppError('forbidden', 403);
    const ids = z.array(uuid).min(1).max(500).parse(orderIds);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('delete_orders', { p_order_ids: ids });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

/** Blacklist the phone numbers of the selected orders (managers). */
export async function blockOrderPhones(input: { orderIds: string[]; reason?: string }) {
  return runAction(async () => {
    await requireUser('orders.manage');
    const p = z.object({ orderIds: uuids, reason: z.string().trim().max(300).optional() }).parse(input);
    const supabase = await createClient();
    const { data: rows, error } = await supabase.from('orders').select('phone').in('id', p.orderIds);
    if (error) throw fromDbError(error);
    const phones = [...new Set((rows ?? []).map((r) => r.phone as string).filter((x) => x && x.replace(/\D/g, '').length >= 9))];
    for (const phone of phones) {
      const { error: e } = await supabase.rpc('block_phone', { p_phone: phone, p_reason: p.reason ?? null });
      if (e) throw fromDbError(e);
    }
    return phones.length;
  });
}

export async function unblockPhone(phone: string) {
  return runAction(async () => {
    await requireUser('orders.manage');
    const supabase = await createClient();
    const { error } = await supabase.rpc('unblock_phone', { p_phone: z.string().trim().min(6).max(30).parse(phone) });
    if (error) throw fromDbError(error);
  });
}

/** Same status for many orders (managers); each change goes through the normal workflow rules. */
export async function bulkChangeStatus(input: { orderIds: string[]; status: string }) {
  return runAction(async () => {
    await requireUser('orders.manage');
    const p = z.object({ orderIds: uuids, status: z.enum(CONFIRMATION_STATUSES).refine((s) => s !== 'postponed') }).parse(input);
    const supabase = await createClient();
    let ok = 0;
    let failed = 0;
    for (const id of p.orderIds) {
      const { error } = await supabase.rpc('set_confirmation_status', { p_order_id: id, p_status: p.status, p_note: null, p_expected_version: null });
      if (error) failed++;
      else ok++;
    }
    return { ok, failed };
  });
}

/** Saved list filters (per user). */
export async function saveOrderFilter(input: { name: string; query: string }) {
  return runAction(async () => {
    await requireUser();
    const p = z.object({ name: z.string().trim().min(1).max(60), query: z.string().max(2000) }).parse(input);
    const supabase = await createClient();
    const { error } = await supabase.from('saved_filters').insert({ name: p.name, query: p.query.replace(/(^|&)page=\d+/g, '') });
    if (error) throw fromDbError(error);
  });
}

export async function deleteOrderFilter(id: string) {
  return runAction(async () => {
    await requireUser();
    const supabase = await createClient();
    const { error } = await supabase.from('saved_filters').delete().eq('id', uuid.parse(id));
    if (error) throw fromDbError(error);
  });
}
