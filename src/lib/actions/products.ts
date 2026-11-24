'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth/session';
import { fromDbError, runAction } from '@/lib/errors';

const money = z.union([z.coerce.number().min(0).max(100_000_000), z.literal('').transform(() => null), z.null()]).optional();
const productSchema = z.object({
  id: z.guid().optional(),
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(80).optional(),
  description: z.string().trim().max(2000).optional(),
  selling_price: z.coerce.number().min(0).max(100_000_000),
  purchase_cost: money,
  packaging_cost: money,
  storage_cost: money,
});

/** Product fields need products.manage; cost fields additionally need finance.manage (also enforced by RLS). */
export async function saveProduct(input: z.input<typeof productSchema>) {
  return runAction(async () => {
    const session = await requireUser('products.manage', 'finance.manage');
    const p = productSchema.parse(input);
    const supabase = await createClient();
    let id = p.id;
    if (session.can('products.manage')) {
      const row = { name: p.name, sku: p.sku || null, description: p.description || null, selling_price: p.selling_price };
      const res = id
        ? await supabase.from('products').update(row).eq('id', id).select('id').single()
        : await supabase.from('products').insert({ ...row, created_by: session.userId }).select('id').single();
      if (res.error) throw fromDbError(res.error);
      id = res.data.id;
    }
    if (id && session.can('finance.manage') && (p.purchase_cost !== undefined || p.packaging_cost !== undefined || p.storage_cost !== undefined)) {
      const { error } = await supabase.from('product_costs').update({
        purchase_cost: p.purchase_cost ?? null, packaging_cost: p.packaging_cost ?? null, storage_cost: p.storage_cost ?? null,
      }).eq('product_id', id);
      if (error) throw fromDbError(error);
    }
    return id;
  });
}

export async function setProductArchived(id: string, archived: boolean) {
  return runAction(async () => {
    await requireUser('products.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('products').update({ is_archived: archived }).eq('id', z.guid().parse(id));
    if (error) throw fromDbError(error);
  });
}

export async function recalculateCosts(input: { productId: string; from: string; to: string }) {
  return runAction(async () => {
    await requireUser('finance.manage');
    const p = z.object({ productId: z.guid(), from: z.string().date(), to: z.string().date() }).parse(input);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('recalculate_item_costs', { p_product_id: p.productId, p_from: p.from, p_to: p.to });
    if (error) throw fromDbError(error);
    return data as number;
  });
}

export async function deleteAlias(id: string) {
  return runAction(async () => {
    await requireUser('products.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('product_aliases').delete().eq('id', z.guid().parse(id));
    if (error) throw fromDbError(error);
  });
}

/** Bulk manual match of every unmatched line with this label. */
export async function matchLabel(input: { itemId: string; productId: string }) {
  return runAction(async () => {
    await requireUser('products.manage', 'orders.manage');
    const p = z.object({ itemId: z.guid(), productId: z.guid() }).parse(input);
    const supabase = await createClient();
    const { error } = await supabase.rpc('match_order_item', { p_item_id: p.itemId, p_product_id: p.productId, p_remember: true });
    if (error) throw fromDbError(error);
  });
}
