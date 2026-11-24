-- =============================================================================
-- 0007 — External integrations: connections, encrypted secrets, Google Sheets
-- =============================================================================

create table public.integration_connections (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider in ('google', 'meta')),
  account_label  text,           -- e-mail / user name of the connected account
  external_user_id text,
  status         text not null default 'connected' check (status in ('connected', 'expired', 'error', 'revoked')),
  scopes         text[] not null default '{}',
  expires_at     timestamptz,
  last_error     text,
  connected_by   uuid references public.profiles (id) on delete set null,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function public.tg_set_updated_at();
create trigger integration_connections_audit after insert or update or delete on public.integration_connections
  for each row execute function public.tg_audit_row();

-- SECRETS. Values are AES-256-GCM encrypted by the application
-- (ENCRYPTION_KEY env var) before being stored. RLS is enabled with NO policy:
-- only the service role (server-side code) can read or write this table.
create table public.integration_secrets (
  owner_type   text not null check (owner_type in ('connection', 'delivery_provider')),
  owner_id     uuid not null,
  ciphertext   text not null,
  updated_at   timestamptz not null default now(),
  primary key (owner_type, owner_id)
);

-- OAuth state (CSRF protection for OAuth flows); short-lived, service role only.
create table public.oauth_states (
  state        text primary key,
  provider     text not null,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  code_verifier text,
  redirect_to  text,
  created_at   timestamptz not null default now()
);

-- Google Sheets sources -------------------------------------------------------
create table public.sheet_sources (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  connection_id          uuid references public.integration_connections (id) on delete set null,
  spreadsheet_id         text not null,
  worksheet_title        text not null,
  header_row             integer not null default 1 check (header_row >= 1),
  -- { field: "Column header" } — see src/lib/integrations/google-sheets/mapping.ts
  column_mapping         jsonb not null default '{}',
  -- { multi_product_separator, quantity_pattern, group_rows_by_external_id, date_format }
  options                jsonb not null default '{}',
  sync_enabled           boolean not null default false,
  sync_interval_minutes  integer not null default 15 check (sync_interval_minutes between 5 and 1440),
  last_synced_at         timestamptz,
  last_sync_status       text,
  last_sync_error        text,
  consecutive_failures   integer not null default 0,
  created_by             uuid references public.profiles (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger sheet_sources_updated_at before update on public.sheet_sources
  for each row execute function public.tg_set_updated_at();
create trigger sheet_sources_audit after insert or update or delete on public.sheet_sources
  for each row execute function public.tg_audit_row();

-- Rows that could not be imported (kept for review; re-tried on next sync)
create table public.sheet_import_errors (
  id             bigint generated always as identity primary key,
  source_id      uuid not null references public.sheet_sources (id) on delete cascade,
  run_id         uuid references public.sync_runs (id) on delete set null,
  row_number     integer,
  external_id    text,
  error          text not null,
  raw            jsonb,
  created_at     timestamptz not null default now()
);
create index sheet_import_errors_source_idx on public.sheet_import_errors (source_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Import / upsert of one order coming from an external source. Runs as one
-- transaction. Existing orders only get permitted customer fields updated, and
-- only while the order has not been confirmed or sent to delivery. Statuses,
-- notes, assignments, delivery data and financial snapshots are never touched.
-- p_order: { external_id, customer_name, phone, phone2, wilaya, commune, address,
--            customer_notes, delivery_fee, total_amount, ordered_at, delivery_type,
--            utm_source, utm_campaign, utm_content, meta_campaign_id, meta_adset_id, meta_ad_id,
--            items: [{ product_name, sku, quantity, unit_price, variant }] }
-- ---------------------------------------------------------------------------
create or replace function public.upsert_external_order(p_source text, p_source_id uuid, p_order jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ext text := nullif(btrim(p_order ->> 'external_id'), '');
  o public.orders;
  v_item jsonb;
  v_wilaya smallint;
  v_total numeric;
begin
  if v_ext is null then
    raise exception 'missing_external_id' using errcode = '22023';
  end if;
  perform set_config('app.actor_label', p_source, true);
  v_wilaya := public.resolve_wilaya(p_order ->> 'wilaya');
  v_total := nullif(p_order ->> 'total_amount', '')::numeric;

  select * into o from public.orders
   where source = p_source
     and coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_source_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and external_id = v_ext
   for update;

  if found then
    if o.confirmation_status in ('new', 'no_answer_1', 'no_answer_2', 'no_answer_3', 'no_answer_4', 'no_answer_5',
                                 'no_answer_6', 'no_answer_7', 'no_answer_8', 'no_answer_9', 'unreachable')
       and o.delivery_status = 'not_submitted' then
      update public.orders set
        customer_name = coalesce(nullif(btrim(p_order ->> 'customer_name'), ''), customer_name),
        phone = coalesce(nullif(btrim(p_order ->> 'phone'), ''), phone),
        phone2 = coalesce(nullif(btrim(p_order ->> 'phone2'), ''), phone2),
        wilaya_code = coalesce(v_wilaya, wilaya_code),
        wilaya_raw = coalesce(nullif(p_order ->> 'wilaya', ''), wilaya_raw),
        commune = coalesce(nullif(btrim(p_order ->> 'commune'), ''), commune),
        address = coalesce(nullif(btrim(p_order ->> 'address'), ''), address),
        customer_notes = coalesce(nullif(btrim(p_order ->> 'customer_notes'), ''), customer_notes)
      where id = o.id
        and (customer_name, phone, coalesce(phone2, ''), coalesce(wilaya_code, 0), coalesce(commune, ''),
             coalesce(address, ''), coalesce(customer_notes, ''))
            is distinct from
            (coalesce(nullif(btrim(p_order ->> 'customer_name'), ''), customer_name),
             coalesce(nullif(btrim(p_order ->> 'phone'), ''), phone),
             coalesce(nullif(btrim(p_order ->> 'phone2'), ''), phone2, ''),
             coalesce(v_wilaya, wilaya_code, 0),
             coalesce(nullif(btrim(p_order ->> 'commune'), ''), commune, ''),
             coalesce(nullif(btrim(p_order ->> 'address'), ''), address, ''),
             coalesce(nullif(btrim(p_order ->> 'customer_notes'), ''), customer_notes, ''));
      if found then
        return jsonb_build_object('action', 'updated', 'order_id', o.id);
      end if;
    end if;
    return jsonb_build_object('action', 'unchanged', 'order_id', o.id);
  end if;

  if jsonb_typeof(p_order -> 'items') <> 'array' or jsonb_array_length(p_order -> 'items') = 0 then
    raise exception 'missing_items' using errcode = '22023';
  end if;

  -- Auto-assignment runs from the orders insert trigger (capacity engine).
  insert into public.orders (
    external_id, source, source_id, customer_name, phone, phone2, wilaya_code, wilaya_raw, commune, address,
    customer_notes, delivery_fee, delivery_type, ordered_at, total_override, total_amount,
    utm_source, utm_campaign, utm_content, meta_campaign_id, meta_adset_id, meta_ad_id)
  values (
    v_ext, p_source, p_source_id,
    btrim(p_order ->> 'customer_name'),
    btrim(p_order ->> 'phone'),
    nullif(btrim(p_order ->> 'phone2'), ''),
    v_wilaya,
    nullif(p_order ->> 'wilaya', ''),
    nullif(btrim(p_order ->> 'commune'), ''),
    nullif(btrim(p_order ->> 'address'), ''),
    nullif(btrim(p_order ->> 'customer_notes'), ''),
    coalesce(nullif(p_order ->> 'delivery_fee', '')::numeric, 0),
    case when p_order ->> 'delivery_type' = 'stopdesk' then 'stopdesk' else 'home' end,
    coalesce(nullif(p_order ->> 'ordered_at', '')::timestamptz, now()),
    v_total is not null,
    coalesce(v_total, 0),
    nullif(p_order ->> 'utm_source', ''), nullif(p_order ->> 'utm_campaign', ''), nullif(p_order ->> 'utm_content', ''),
    nullif(p_order ->> 'meta_campaign_id', ''), nullif(p_order ->> 'meta_adset_id', ''), nullif(p_order ->> 'meta_ad_id', ''))
  returning * into o;

  for v_item in select * from jsonb_array_elements(p_order -> 'items') loop
    insert into public.order_items (order_id, product_name, sku, variant, quantity, unit_price)
    values (o.id,
            coalesce(nullif(btrim(v_item ->> 'product_name'), ''), nullif(btrim(v_item ->> 'sku'), ''), '?'),
            nullif(btrim(v_item ->> 'sku'), ''),
            nullif(btrim(v_item ->> 'variant'), ''),
            greatest(coalesce(nullif(v_item ->> 'quantity', '')::integer, 1), 1),
            coalesce(nullif(v_item ->> 'unit_price', '')::numeric, 0));
  end loop;

  return jsonb_build_object('action', 'created', 'order_id', o.id,
    'unmatched', exists (select 1 from public.order_items where order_id = o.id and product_id is null));
end
$$;
