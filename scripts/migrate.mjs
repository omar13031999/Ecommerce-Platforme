#!/usr/bin/env node
/**
 * Build-time database setup (runs before `next build` on Vercel).
 *  1. Applies supabase/migrations/*.sql that were not applied yet (tracked in
 *     public._app_migrations), each in its own transaction.
 *  2. Schedules the background jobs with pg_cron + pg_net (every 5 minutes),
 *     calling ${APP_URL}/api/cron with CRON_SECRET stored in Supabase Vault.
 *  3. Promotes OWNER_EMAIL (an existing Supabase Auth user) to owner/admin.
 * Skips silently when no database URL is configured (local builds).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  console.log('[migrate] no database URL configured — skipping');
  process.exit(0);
}

const log = (...a) => console.log('[migrate]', ...a);
const clean = url.replace(/([?&])sslmode=[^&]*&?/g, '$1').replace(/[?&]$/, '');
const client = new pg.Client({
  connectionString: clean,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  statement_timeout: 120000,
});
const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

try {
  await client.connect();
  await client.query('create table if not exists public._app_migrations (name text primary key, applied_at timestamptz not null default now())');
  await client.query('alter table public._app_migrations enable row level security');
  await client.query('revoke all on public._app_migrations from anon, authenticated').catch(() => {});

  const dir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query('select name from public._app_migrations');
  const applied = new Set(rows.map((r) => r.name));
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    log('applying', f);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public._app_migrations (name) values ($1)', [f]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`${f}: ${e.message}`);
    }
  }
  log(`schema up to date (${files.length} migrations)`);

  const appUrl = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (appUrl && secret) {
    try {
      await client.query('create extension if not exists pg_cron');
      await client.query('create extension if not exists pg_net');
      const existing = await client.query("select id from vault.secrets where name = 'app_cron_secret'");
      if (existing.rowCount) await client.query('select vault.update_secret($1, $2)', [existing.rows[0].id, secret]);
      else await client.query("select vault.create_secret($1, 'app_cron_secret')", [secret]);
      const target = `${appUrl.replace(/\/$/, '')}/api/cron`;
      const command = `select net.http_get(url := ${sqlLiteral(target)}, headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'app_cron_secret')), timeout_milliseconds := 120000)`;
      await client.query("select cron.schedule('app-jobs', '*/5 * * * *', $1)", [command]);
      log('scheduler: every 5 minutes ->', target);
    } catch (e) {
      log('scheduler not configured:', e.message);
    }
  }

  const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (owner) {
    const exists = await client.query('select 1 from auth.users where lower(email) = $1', [owner]);
    if (!exists.rowCount) {
      log('owner account not created yet in Supabase Auth');
    } else {
      const r = await client.query(
        `update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin","active":true}'::jsonb
          where lower(email) = $1 and coalesce(raw_app_meta_data ->> 'role', '') <> 'admin'`,
        [owner],
      );
      // Accounts created before the schema existed have no profile row yet.
      await client.query(
        `insert into public.profiles (id, full_name, email)
         select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', split_part(coalesce(u.email, ''), '@', 1)), u.email
           from auth.users u on conflict (id) do nothing`,
      );
      await client.query(`update public.profiles set role = 'admin', is_active = true where lower(email) = $1 and (role <> 'admin' or not is_active)`, [owner]);
      log(r.rowCount ? 'owner promoted to admin' : 'owner already admin');
    }
  }
} catch (e) {
  console.error('[migrate] FAILED:', e.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
