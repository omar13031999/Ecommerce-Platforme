import 'server-only';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { randomToken } from '@/lib/crypto';

/** Stores a single-use OAuth state bound to the initiating user (CSRF protection). */
export async function createOAuthState(provider: 'google' | 'meta', userId: string) {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const { error } = await createAdminClient().from('oauth_states').insert({ state, provider, user_id: userId, code_verifier: verifier });
  if (error) throw error;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge };
}

/** Consumes the state: valid once, for the same user, within 10 minutes. */
export async function consumeOAuthState(provider: 'google' | 'meta', state: string, userId: string) {
  const db = createAdminClient();
  const { data } = await db.from('oauth_states').delete().eq('state', state).eq('provider', provider).select('user_id, code_verifier, created_at').maybeSingle();
  await db.from('oauth_states').delete().lt('created_at', new Date(Date.now() - 3600_000).toISOString());
  if (!data || data.user_id !== userId || Date.now() - Date.parse(data.created_at) > 600_000) return null;
  return { verifier: data.code_verifier as string };
}
