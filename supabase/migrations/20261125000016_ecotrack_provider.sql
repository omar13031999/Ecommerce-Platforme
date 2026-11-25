-- Daily ECOTRACK reference sync (communes + products) is logged in sync_runs.
alter table public.sync_runs drop constraint if exists sync_runs_kind_check;
alter table public.sync_runs add constraint sync_runs_kind_check check (kind in (
  'google_sheets', 'delivery_poll', 'delivery_submit', 'meta_ads',
  'recurring_expenses', 'assignment', 'redistribution', 'settlement_import', 'ecotrack_reference'));

-- Providers created as "API REST configurable" pointing at an ECOTRACK instance
-- with no configuration cannot submit anything (create_endpoint_not_configured):
-- switch them to the dedicated ECOTRACK adapter. The saved API key (api_key) is
-- the ECOTRACK token for both adapters, so credentials are kept as they are.
update public.delivery_providers
   set code = 'ecotrack', config = '{}'::jsonb, polling_enabled = true,
       tracking_url_template = case when tracking_url_template like '%{tracking}%' then tracking_url_template else null end
 where code = 'rest'
   and base_url ilike '%ecotrack%'
   and (config is null or config = '{}'::jsonb or not (config ? 'create'));
