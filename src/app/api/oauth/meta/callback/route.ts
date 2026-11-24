import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { exchangeMetaCode, metaMe, META_SCOPES } from '@/lib/integrations/meta/meta';
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
  if (!(await consumeOAuthState('meta', state, session.userId))) return back('error=oauth_state');
  try {
    const token = await exchangeMetaCode(code);
    const me = await metaMe(token.access_token);
    const db = createAdminClient();
    const { data: existing } = await db.from('integration_connections').select('id').eq('provider', 'meta').eq('external_user_id', me.id).maybeSingle();
    const row = {
      provider: 'meta', account_label: me.name, external_user_id: me.id, status: 'connected', scopes: META_SCOPES,
      expires_at: token.expires_at ? new Date(token.expires_at).toISOString() : null, connected_by: session.userId, last_error: null,
      connected_at: new Date().toISOString(),
    };
    const { data, error } = existing
      ? await db.from('integration_connections').update(row).eq('id', existing.id).select('id').single()
      : await db.from('integration_connections').insert(row).select('id').single();
    if (error) throw error;
    await setSecret('connection', data.id, token);
    return back('connected=meta');
  } catch (e) {
    console.error('[oauth:meta]', e);
    return back('error=oauth_failed');
  }
}
