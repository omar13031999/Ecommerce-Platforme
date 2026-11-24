'use server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth/session';
import { AppError, fromDbError, runAction } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';

const createSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().max(30).optional(),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'manager', 'agent']),
  max_active_orders: z.coerce.number().int().min(0).max(10000),
  locale: z.enum(['fr', 'ar']).default('fr'),
});

/**
 * Creates a staff account. Managers may only create agents; only the owner
 * (admin) may create managers/admins. Role is set in app_metadata (not
 * user-editable) and the DB trigger creates the profile.
 */
export async function createStaffMember(input: z.input<typeof createSchema>) {
  return runAction(async () => {
    const session = await requireUser('team.manage');
    const p = createSchema.safeParse(input);
    if (!p.success) {
      const pw = p.error.issues.some((i) => i.path[0] === 'password');
      throw new AppError(pw ? 'weak_password' : 'invalid_input', 400, p.error.flatten().fieldErrors);
    }
    if (p.data.role !== 'agent' && session.profile.role !== 'admin') throw new AppError('forbidden_role', 403);

    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email: p.data.email,
      password: p.data.password,
      email_confirm: true,
      app_metadata: { role: p.data.role, active: true },
      user_metadata: { full_name: p.data.full_name, locale: p.data.locale },
    });
    if (error || !data.user) {
      if (error?.message?.toLowerCase().includes('already')) throw new AppError('email_taken', 409);
      if (error?.message?.toLowerCase().includes('password')) throw new AppError('weak_password');
      throw new AppError('unknown');
    }
    const { error: upErr } = await admin.from('profiles').update({ max_active_orders: p.data.max_active_orders, phone: p.data.phone || null }).eq('id', data.user.id);
    if (upErr) throw fromDbError(upErr);
    await admin.rpc('log_audit', { p_action: 'staff_create', p_entity_type: 'profiles', p_entity_id: data.user.id, p_before: null, p_after: { role: p.data.role, email: p.data.email, by: session.userId } });
    // A new agent may absorb waiting orders.
    if (p.data.role === 'agent') await admin.rpc('assign_waiting_orders', { p_limit: p.data.max_active_orders });
    return data.user.id;
  });
}

const updateSchema = z.object({
  userId: z.guid(),
  patch: z.object({
    full_name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(30).optional(),
    role: z.enum(['admin', 'manager', 'agent']).optional(),
    permissions: z.array(z.enum(PERMISSIONS)).optional(),
    is_active: z.boolean().optional(),
    max_active_orders: z.coerce.number().int().min(0).max(10000).optional(),
    accepts_assignments: z.boolean().optional(),
  }),
});

/** All rules (who may change what, last admin, release of orders) live in update_staff_member(). */
export async function updateStaffMember(input: z.input<typeof updateSchema>) {
  return runAction(async () => {
    await requireUser('team.manage');
    const p = updateSchema.parse(input);
    const supabase = await createClient();
    const { error } = await supabase.rpc('update_staff_member', { p_user_id: p.userId, p_patch: p.patch });
    if (error) throw fromDbError(error);
    // Keep auth app_metadata consistent with the profile (defence in depth).
    if (p.patch.role !== undefined || p.patch.is_active !== undefined) {
      const { data: prof } = await supabase.from('profiles').select('role, is_active').eq('id', p.userId).single();
      if (prof) {
        await createAdminClient().auth.admin.updateUserById(p.userId, {
          app_metadata: { role: prof.role, active: prof.is_active },
          ...(prof.is_active ? { ban_duration: 'none' } : { ban_duration: '876000h' }),
        });
      }
    }
  });
}

export async function resetStaffPassword(input: { userId: string; password: string }) {
  return runAction(async () => {
    const session = await requireUser('team.manage');
    const p = z.object({ userId: z.guid(), password: z.string().min(8).max(200) }).safeParse(input);
    if (!p.success) throw new AppError('weak_password');
    const supabase = await createClient();
    const { data: target } = await supabase.from('profiles').select('role').eq('id', p.data.userId).single();
    if (!target) throw new AppError('user_not_found');
    if (target.role !== 'agent' && session.profile.role !== 'admin') throw new AppError('forbidden_target', 403);
    const { error } = await createAdminClient().auth.admin.updateUserById(p.data.userId, { password: p.data.password });
    if (error) throw new AppError('weak_password');
    await createAdminClient().rpc('log_audit', { p_action: 'password_reset', p_entity_type: 'profiles', p_entity_id: p.data.userId, p_before: null, p_after: { by: session.userId } });
  });
}
