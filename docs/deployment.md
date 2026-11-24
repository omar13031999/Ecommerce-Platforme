# Deployment (Supabase + Vercel)

1. **Supabase**: apply `supabase/migrations/*` in order. Auth → Sign In / Providers → disable *Allow new users to sign up*.
   Auth → URL Configuration → *Site URL* = your app URL.
2. **Vercel**: import the GitHub repository (framework: Next.js) and set the environment variables from `.env.example`
   (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `CRON_SECRET`,
   `ENCRYPTION_KEY`, optional Google/Meta). Deploy.
3. **First owner**: Supabase → Authentication → Users → *Add user* (auto-confirm), then promote it:

   ```sql
   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin","active":true}'
   where email = 'owner@example.com';
   ```

4. **Scheduler** (every 5 minutes, via the database):

   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
   select cron.schedule('app-jobs', '*/5 * * * *', $$
     select net.http_get(
       url := 'https://<your-app>.vercel.app/api/cron',
       headers := jsonb_build_object('Authorization', 'Bearer ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       timeout_milliseconds := 60000)
   $$);
   ```

   `ENCRYPTION_KEY` must never change after integrations are configured (stored credentials would become unreadable).

## Automatic setup on Vercel (used in production)

`npm run build` runs `scripts/migrate.mjs` first. With the Vercel ↔ Supabase integration
(`POSTGRES_URL_NON_POOLING`) it applies pending migrations, schedules `/api/cron` every 5 minutes via
`pg_cron` (needs `APP_URL` + `CRON_SECRET`) and promotes `OWNER_EMAIL` to owner once that user exists in
Supabase Auth. Redeploy after creating the owner account.
