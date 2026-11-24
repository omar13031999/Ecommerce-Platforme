import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { exchangeGoogleCode, googleUserEmail, GOOGLE_SCOPES } from '@/lib/integrations/google-sheets/google';
import { consumeOAuthState } from '@/lib/services/oauth';
import { setSecret } from '@/lib/services/secrets';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/settings/integrations?${q}`, req.url));
  const session = await getSession();
  if (!session?.can('integrations.manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return back('error=oauth_denied');
  const st = await consumeOAuthState('google', state, session.userId);
  if (!st) return back('error=oauth_state');
  try {
    const tokens = await exchangeGoogleCode(code, st.verifier);
    const email = await googleUserEmail(tokens.access_token).catch(() => null);
    const db = createAdminClient();
    const { data: existing } = await db.from('integration_connections').select('id').eq('provider', 'google').eq('account_label', email ?? '').maybeSingle();
    const row = { provider: 'google', account_label: email, status: 'connected', scopes: tokens.scope?.split(' ') ?? GOOGLE_SCOPES, connected_by: session.userId, last_error: null, connected_at: new Date().toISOString() };
    const { data, error } = existing
      ? await db.from('integration_connections').update(row).eq('id', existing.id).select('id').single()
      : await db.from('integration_connections').insert(row).select('id').single();
    if (error) throw error;
    await setSecret('connection', data.id, tokens);
    return back('connected=google');
  } catch (e) {
    console.error('[oauth:google]', e);
    return back('error=oauth_failed');
  }
}
