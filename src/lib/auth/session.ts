import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { effectivePermissions, type Permission, type Role } from './permissions';
import { AppError } from '@/lib/errors';

export type Profile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  permissions: string[];
  is_active: boolean;
  locale: 'fr' | 'ar';
  max_active_orders: number;
  accepts_assignments: boolean;
};

export type Session = {
  userId: string;
  profile: Profile;
  permissions: Set<Permission>;
  can: (p: Permission) => boolean;
};

/** Current user + profile (memoised per request). Null when signed out/inactive. */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, email, phone, role, permissions, is_active, locale, max_active_orders, accepts_assignments')
    .eq('id', userData.user.id)
    .single<Profile>();
  if (!profile || !profile.is_active) return null;
  const permissions = effectivePermissions(profile.role, profile.permissions ?? []);
  return { userId: profile.id, profile, permissions, can: (p) => permissions.has(p) };
});

/** For pages: redirect to login when signed out, to dashboard when forbidden. */
export async function requirePage(...perms: Permission[]): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (perms.length && !perms.some((p) => session.can(p))) redirect('/dashboard?denied=1');
  return session;
}

/** For server actions / route handlers: throws (never trusts the client). */
export async function requireUser(...perms: Permission[]): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AppError('unauthorized', 401);
  if (perms.length && !perms.some((p) => session.can(p))) throw new AppError('forbidden', 403);
  return session;
}
