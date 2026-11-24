import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { refreshGoogleToken, type GoogleTokens } from '@/lib/integrations/google-sheets/google';
import { ProviderError } from '@/lib/integrations/http';
import { getSecret, setSecret } from './secrets';

/** Valid access token for a Google connection (refreshing and persisting it). */
export async function googleAccessToken(connectionId: string): Promise<string> {
  const tokens = await getSecret<GoogleTokens>('connection', connectionId);
  if (!tokens) throw new ProviderError('auth', 'google_not_connected');
  try {
    const fresh = await refreshGoogleToken(tokens);
    if (fresh.access_token !== tokens.access_token) await setSecret('connection', connectionId, fresh);
    return fresh.access_token;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'auth') {
      await createAdminClient().from('integration_connections')
        .update({ status: 'expired', last_error: e.message }).eq('id', connectionId);
    }
    throw e;
  }
}
