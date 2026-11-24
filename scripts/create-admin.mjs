#!/usr/bin/env node
// Bootstrap the first owner (admin) account. Requires NEXT_PUBLIC_SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY in the environment (e.g. `node --env-file=.env.local`).
import { createClient } from '@supabase/supabase-js';

const [email, password, fullName = 'Owner'] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: node scripts/create-admin.mjs <email> <password (8+ chars)> [full name]');
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  app_metadata: { role: 'admin', active: true },
  user_metadata: { full_name: fullName, locale: 'fr' },
});
if (error) {
  console.error('Failed:', error.message);
  process.exit(1);
}
console.log(`Owner account created: ${data.user.id} (${email})`);
