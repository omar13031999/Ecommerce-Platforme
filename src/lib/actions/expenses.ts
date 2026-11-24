'use server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth/session';
import { AppError, fromDbError, runAction } from '@/lib/errors';

const KINDS = ['overhead', 'advertising', 'salary', 'confirmation', 'packaging', 'storage', 'delivery', 'product_purchase', 'returns', 'software', 'other'] as const;
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const optUuid = z.guid().or(z.literal('')).optional().transform((v) => v || null);

const expenseSchema = z.object({
  id: z.guid().optional(),
  title: z.string().trim().min(1).max(200),
  category_id: z.guid(),
  amount: z.coerce.number().min(0).max(1_000_000_000),
  amount_paid: z.coerce.number().min(0).max(1_000_000_000).default(0),
  expense_date: z.string().date(),
  description: z.string().trim().max(2000).optional(),
  payment_method: z.string().trim().max(80).optional(),
  payee: z.string().trim().max(200).optional(),
  reference: z.string().trim().max(120).optional(),
  payment_status: z.enum(['paid', 'unpaid', 'partial']),
  order_reference: z.string().trim().regex(/^\d*$/).optional(),
  product_id: optUuid,
  employee_id: optUuid,
});

export async function saveExpense(formData: FormData) {
  return runAction(async () => {
    const s = await requireUser('expenses.manage');
    const p = expenseSchema.parse(Object.fromEntries([...formData.entries()].filter(([k]) => k !== 'attachment')));
    const supabase = await createClient();
    let orderId: string | null = null;
    if (p.order_reference) {
      const { data } = await supabase.from('orders').select('id').eq('reference', Number(p.order_reference)).maybeSingle();
      if (!data) throw new AppError('order_not_found');
      orderId = data.id;
    }
    const row = {
      title: p.title, category_id: p.category_id, amount: p.amount,
      amount_paid: p.payment_status === 'paid' ? p.amount : p.payment_status === 'unpaid' ? 0 : p.amount_paid,
      expense_date: p.expense_date, description: p.description || null, payment_method: p.payment_method || null,
      payee: p.payee || null, reference: p.reference || null, payment_status: p.payment_status,
      order_id: orderId, product_id: p.product_id, employee_id: p.employee_id,
    };
    const res = p.id
      ? await supabase.from('expenses').update(row).eq('id', p.id).select('id').single()
      : await supabase.from('expenses').insert({ ...row, created_by: s.userId }).select('id').single();
    if (res.error) throw fromDbError(res.error);

    const file = formData.get('attachment');
    if (file instanceof File && file.size > 0) {
      if (file.size > 5 * 1024 * 1024) throw new AppError('file_too_large');
      if (!ALLOWED_MIME.includes(file.type)) throw new AppError('invalid_file');
      const path = `expenses/${res.data.id}/${randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
      const { error } = await createAdminClient().storage.from('expense-attachments').upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new AppError('unknown');
      await supabase.from('expenses').update({ attachment_path: path }).eq('id', res.data.id);
    }
    return res.data.id as string;
  });
}

export async function deleteExpense(id: string) {
  return runAction(async () => {
    await requireUser('expenses.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('expenses').delete().eq('id', z.guid().parse(id));
    if (error) throw fromDbError(error);
  });
}

const categorySchema = z.object({
  id: z.guid().optional(),
  name: z.string().trim().min(1).max(80),
  name_ar: z.string().trim().max(80).optional(),
  kind: z.enum(KINDS),
  profit_treatment: z.enum(['deduct', 'informational']),
  is_archived: z.boolean().default(false),
});

export async function saveCategory(input: z.input<typeof categorySchema>) {
  return runAction(async () => {
    await requireUser('expenses.manage');
    const p = categorySchema.parse(input);
    const supabase = await createClient();
    const row = { name: p.name, name_ar: p.name_ar || null, kind: p.kind, profit_treatment: p.profit_treatment, is_archived: p.is_archived };
    const { error } = p.id ? await supabase.from('expense_categories').update(row).eq('id', p.id) : await supabase.from('expense_categories').insert(row);
    if (error) throw fromDbError(error);
  });
}

/** Deletion only when unused (FK violation -> 'in_use'); otherwise archive. */
export async function deleteCategory(id: string) {
  return runAction(async () => {
    await requireUser('expenses.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('expense_categories').delete().eq('id', z.guid().parse(id));
    if (error) throw fromDbError(error);
  });
}

const recurringSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category_id: z.guid(),
  amount: z.coerce.number().min(0).max(1_000_000_000),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'custom']),
  interval_days: z.coerce.number().int().min(1).max(3650).optional(),
  start_date: z.string().date(),
  end_date: z.string().date().or(z.literal('')).optional(),
  payee: z.string().trim().max(200).optional(),
  payment_method: z.string().trim().max(80).optional(),
  default_status: z.enum(['paid', 'unpaid', 'partial']),
  employee_id: optUuid,
});

export async function saveRecurring(input: z.input<typeof recurringSchema>) {
  return runAction(async () => {
    const s = await requireUser('expenses.manage');
    const p = recurringSchema.parse(input);
    if (p.frequency === 'custom' && !p.interval_days) throw new AppError('invalid_input', 400, { interval_days: ['required'] });
    const supabase = await createClient();
    const { error } = await supabase.from('recurring_expenses').insert({
      title: p.title, category_id: p.category_id, amount: p.amount, frequency: p.frequency,
      interval_days: p.frequency === 'custom' ? p.interval_days : null, start_date: p.start_date, next_run_date: p.start_date,
      end_date: p.end_date || null, payee: p.payee || null, payment_method: p.payment_method || null,
      default_status: p.default_status, employee_id: p.employee_id, created_by: s.userId,
    });
    if (error) throw fromDbError(error);
  });
}

export async function toggleRecurring(id: string, active: boolean) {
  return runAction(async () => {
    await requireUser('expenses.manage');
    const supabase = await createClient();
    const { error } = await supabase.from('recurring_expenses').update({ is_active: active }).eq('id', z.guid().parse(id));
    if (error) throw fromDbError(error);
  });
}

/** Generation runs with the service role (function not exposed), after the permission check. */
export async function generateRecurringNow() {
  return runAction(async () => {
    await requireUser('expenses.manage');
    const { data, error } = await createAdminClient().rpc('generate_recurring_expenses', {});
    if (error) throw fromDbError(error);
    return data as number;
  });
}
