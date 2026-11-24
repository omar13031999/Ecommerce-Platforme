import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/env';

let admin: SupabaseClient | null = null;

/**
 * Service-role client. BYPASSES RLS — use only in trusted server code (cron
 * jobs, webhooks, integrations, auth administration) AFTER an explicit
 * authorization check. Never import from client components.
 */
export function createAdminClient(): SupabaseClient {
  if (admin) return admin;
  const env = serverEnv();
  admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
