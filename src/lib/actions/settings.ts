'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth/session';
import { fromDbError, runAction } from '@/lib/errors';
import { CONFIRMATION_STATUSES } from '@/lib/domain/statuses';

const SCHEMAS = {
  assignment: z.object({
    auto_assign_enabled: z.boolean(),
    workload_statuses: z.array(z.enum(CONFIRMATION_STATUSES)).min(1),
    redistribution_enabled: z.boolean(),
    redistribution_threshold: z.coerce.number().int().min(1).max(9),
    max_redistributions: z.coerce.number().int().min(0).max(20),
    final_no_answer_status: z.enum(['no_answer_3', 'no_answer_4', 'no_answer_5', 'no_answer_6', 'no_answer_7', 'no_answer_8', 'no_answer_9']),
    final_action: z.enum(['review', 'cancel']),
  }),
  delivery: z.object({ auto_submit_enabled: z.boolean(), default_provider_id: z.guid().nullable() }),
  operational_costs: z.object({
    confirmation_cost: z.coerce.number().min(0).max(1e6), packaging_cost: z.coerce.number().min(0).max(1e6),
    storage_cost: z.coerce.number().min(0).max(1e6), other_cost: z.coerce.number().min(0).max(1e6),
  }),
  finance: z.object({ include_customer_delivery_fee_in_revenue: z.boolean(), product_recovered_on_return: z.boolean() }),
  ads_allocation: z.object({ use_attribution: z.boolean(), fallback_method: z.enum(['equal', 'distributed', 'revenue', 'manual']) }),
} as const;
export type SettingKey = keyof typeof SCHEMAS;

export async function saveSetting(key: SettingKey, value: unknown) {
  return runAction(async () => {
    const s = await requireUser('settings.manage');
    const schema = SCHEMAS[key];
    const parsed = schema.parse(value);
    const supabase = await createClient();
    const { error } = await supabase.from('app_settings').update({ value: parsed, updated_by: s.userId }).eq('key', key);
    if (error) throw fromDbError(error);
    if (key === 'assignment') {
      // New rules may free capacity / trigger pending redistributions.
      const admin = createAdminClient();
      await admin.rpc('assign_waiting_orders', { p_limit: 500 });
      await admin.rpc('run_redistribution_sweep', { p_limit: 500 });
    }
  });
}
