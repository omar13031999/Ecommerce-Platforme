'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { LOCALE_COOKIE, isLocale } from '@/i18n/config';
import { AppError, runAction } from '@/lib/errors';
import { requireUser } from '@/lib/auth/session';

const signInSchema = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });

export async function signIn(_prev: unknown, formData: FormData) {
  const parsed = signInSchema.safeParse({ email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return { error: 'invalidCredentials' as const };
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error || !data.user) return { error: 'invalidCredentials' as const };

  const { data: profile } = await supabase.from('profiles').select('is_active, locale').eq('id', data.user.id).single();
  if (!profile?.is_active) {
    await supabase.auth.signOut();
    return { error: 'inactive' as const };
  }
  (await cookies()).set(LOCALE_COOKIE, profile.locale, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  const next = String(formData.get('next') ?? '');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/** Saves the language in the user's account AND the cookie used for rendering. */
export async function setLocale(locale: string) {
  return runAction(async () => {
    if (!isLocale(locale)) throw new AppError('invalid_input');
    await requireUser();
    const supabase = await createClient();
    const { error } = await supabase.rpc('set_my_locale', { p_locale: locale });
    if (error) throw new AppError('unknown');
    (await cookies()).set(LOCALE_COOKIE, locale, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  });
}
