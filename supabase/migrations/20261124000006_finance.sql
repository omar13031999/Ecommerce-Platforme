-- =============================================================================
-- 0006 — Finance: per-order cost snapshots, COD settlements, expenses, ads
-- Everything in this file is CONFIDENTIAL (see RLS migration).
-- =============================================================================

-- Per-order cost snapshot (delivery provider cost, operational costs)
create table public.order_financials (
  order_id                 uuid primary key references public.orders (id) on delete cascade,
  actual_delivery_cost     numeric(12, 2),  -- real provider charge (API / import / manual)
  delivery_cost_source     text check (delivery_cost_source in ('provider_api', 'import', 'manual')),
  estimated_delivery_cost  numeric(12, 2),  -- from delivery_rates, used until the real cost is known
  return_fee               numeric(12, 2) not null default 0,
  exchange_fee             numeric(12, 2) not null default 0,
  confirmation_cost        numeric(12, 2) not null default 0,
  packaging_cost           numeric(12, 2) not null default 0,
  storage_cost             numeric(12, 2) not null default 0,
  other_cost               numeric(12, 2) not null default 0,
  extra_direct_cost        numeric(12, 2) not null default 0,
  ops_manual_override      boolean not null default false,
  allocated_ad_cost        numeric(12, 2),  -- ESTIMATE written by allocation runs; never added to ad spend twice
  notes                    text,
  updated_at               timestamptz not null default now()
);

create trigger order_financials_updated_at before update on public.order_financials
  for each row execute function public.tg_set_updated_at();

-- Snapshot operational defaults at order creation.
create or replace function public.tg_order_init_financials()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := coalesce(public.get_setting('operational_costs'), '{}'::jsonb);
begin
  insert into public.order_financials (order_id, confirmation_cost, packaging_cost, storage_cost, other_cost)
  values (new.id,
          coalesce((s ->> 'confirmation_cost')::numeric, 0),
          coalesce((s ->> 'packaging_cost')::numeric, 0),
          coalesce((s ->> 'storage_cost')::numeric, 0),
          coalesce((s ->> 'other_cost')::numeric, 0))
  on conflict (order_id) do nothing;
  return null;
end
$$;

create trigger orders_init_financials after insert on public.orders
  for each row execute function public.tg_order_init_financials();

-- Product-level operational overrides (packaging/storage) applied when items change.
create or replace function public.refresh_order_operational_costs(p_order_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := coalesce(public.get_setting('operational_costs'), '{}'::jsonb);
begin
  update public.order_financials f set
    packaging_cost = coalesce((select max(pc.packaging_cost) from public.order_items i
                                join public.product_costs pc on pc.product_id = i.product_id
                               where i.order_id = p_order_id),
                              (s ->> 'packaging_cost')::numeric, 0),
    storage_cost = coalesce((select max(pc.storage_cost) from public.order_items i
                              join public.product_costs pc on pc.product_id = i.product_id
                             where i.order_id = p_order_id),
                            (s ->> 'storage_cost')::numeric, 0)
  where f.order_id = p_order_id and not f.ops_manual_override;
end
$$;

create or replace function public.tg_items_refresh_ops()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.refresh_order_operational_costs(coalesce(new.order_id, old.order_id));
  return null;
end
$$;

create trigger order_items_refresh_ops after insert or update of product_id or delete on public.order_items
  for each row execute function public.tg_items_refresh_ops();

-- Delivery cost estimate from provider tariffs when provider/wilaya/type change.
create or replace function public.tg_order_delivery_estimate()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r public.delivery_rates;
begin
  if new.delivery_provider_id is null or new.wilaya_code is null then
    return null;
  end if;
  select * into r from public.delivery_rates
   where provider_id = new.delivery_provider_id and wilaya_code = new.wilaya_code;
  if found then
    update public.order_financials set
      estimated_delivery_cost = case when new.delivery_type = 'stopdesk' then coalesce(r.stopdesk_cost, r.home_cost) else r.home_cost end,
      return_fee = case when new.delivery_status = 'returned' and return_fee = 0 then coalesce(r.return_cost, 0) else return_fee end
    where order_id = new.id;
  end if;
  return null;
end
$$;

create trigger orders_delivery_estimate
  after update of delivery_provider_id, wilaya_code, delivery_type, delivery_status on public.orders
  for each row execute function public.tg_order_delivery_estimate();

-- ---------------------------------------------------------------------------
-- COD reconciliation. Delivery status is NEVER proof of settlement.
-- ---------------------------------------------------------------------------
create table public.cod_settlements (
  order_id            uuid primary key references public.orders (id) on delete cascade,
  provider_id         uuid references public.delivery_providers (id) on delete set null,
  expected_amount     numeric(12, 2) not null default 0,  -- COD the customer should pay
  collected_amount    numeric(12, 2),                     -- amount the courier reports collected
  provider_fees       numeric(12, 2),                     -- fees deducted by the provider from the COD
  transferred_amount  numeric(12, 2),                     -- amount actually received by the business
  transfer_date       date,
  payment_reference   text,
  batch_reference     text,
  status              text not null default 'pending'
                      check (status in ('pending', 'collected', 'partially_transferred', 'transferred', 'discrepancy', 'not_applicable')),
  notes               text,
  updated_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index cod_settlements_status_idx on public.cod_settlements (status, provider_id);

create trigger cod_settlements_updated_at before update on public.cod_settlements
  for each row execute function public.tg_set_updated_at();
create trigger cod_settlements_audit after update or delete on public.cod_settlements
  for each row execute function public.tg_audit_row();

-- Derive status from amounts (manual 'not_applicable' is kept).
create or replace function public.tg_settlement_status()
returns trigger language plpgsql as $$
declare
  v_net_expected numeric;
begin
  if new.status = 'not_applicable' then
    return new;
  end if;
  v_net_expected := coalesce(new.collected_amount, new.expected_amount) - coalesce(new.provider_fees, 0);
  new.status := case
    when new.transferred_amount is null and new.collected_amount is null then 'pending'
    when new.transferred_amount is null then 'collected'
    when new.transferred_amount < v_net_expected then 'partially_transferred'
    when new.transferred_amount > v_net_expected then 'discrepancy'
    else 'transferred'
  end;
  if new.collected_amount is not null and new.collected_amount <> new.expected_amount then
    new.status := 'discrepancy';
  end if;
  return new;
end
$$;

create trigger cod_settlements_status before insert or update on public.cod_settlements
  for each row execute function public.tg_settlement_status();

create or replace function public.tg_order_settlement_open()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.delivery_status in ('distributed', 'delivered')
     and old.delivery_status is distinct from new.delivery_status then
    insert into public.cod_settlements (order_id, provider_id, expected_amount)
    values (new.id, new.delivery_provider_id, new.total_amount)
    on conflict (order_id) do nothing;
  end if;
  return null;
end
$$;

create trigger orders_settlement_open after update of delivery_status on public.orders
  for each row execute function public.tg_order_settlement_open();

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------
create table public.expense_categories (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  name_ar           text,
  kind              text not null default 'overhead' check (kind in (
                      'overhead', 'advertising', 'salary', 'confirmation', 'packaging', 'storage',
                      'delivery', 'product_purchase', 'returns', 'software', 'other')),
  -- deduct: subtracted from net profit. informational: cash record only, because
  -- the same cost is already counted elsewhere (order snapshots, COGS, Meta API).
  profit_treatment  text not null default 'deduct' check (profit_treatment in ('deduct', 'informational')),
  is_archived       boolean not null default false,
  sort_order        integer not null default 100,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index expense_categories_name_uidx on public.expense_categories (lower(name));

create trigger expense_categories_updated_at before update on public.expense_categories
  for each row execute function public.tg_set_updated_at();
create trigger expense_categories_audit after insert or update or delete on public.expense_categories
  for each row execute function public.tg_audit_row();

insert into public.expense_categories (name, name_ar, kind, profit_treatment, sort_order) values
  ('Publicité Meta', 'إعلانات ميتا', 'advertising', 'informational', 10),
  ('Publicité Google', 'إعلانات جوجل', 'advertising', 'deduct', 20),
  ('Coûts de confirmation', 'تكاليف التأكيد', 'confirmation', 'deduct', 30),
  ('Salaires', 'الرواتب', 'salary', 'deduct', 40),
  ('Stockage', 'التخزين', 'storage', 'deduct', 50),
  ('Emballage', 'التغليف', 'packaging', 'deduct', 60),
  ('Livraison', 'التوصيل', 'delivery', 'informational', 70),
  ('Achat de produits', 'شراء المنتجات', 'product_purchase', 'informational', 80),
  ('Abonnements logiciels', 'اشتراكات البرامج', 'software', 'deduct', 90),
  ('Internet', 'الإنترنت', 'overhead', 'deduct', 100),
  ('Frais de bureau', 'مصاريف المكتب', 'overhead', 'deduct', 110),
  ('Retours et échanges', 'المرتجعات والاستبدال', 'returns', 'deduct', 120),
  ('Autres', 'أخرى', 'other', 'deduct', 200);

create table public.recurring_expenses (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  category_id      uuid not null references public.expense_categories (id),
  amount           numeric(12, 2) not null check (amount >= 0),
  frequency        text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly', 'custom')),
  interval_days    integer check (interval_days is null or interval_days between 1 and 3650), -- custom
  start_date       date not null,
  end_date         date,
  next_run_date    date not null,
  payment_method   text,
  payee            text,
  employee_id      uuid references public.profiles (id) on delete set null,
  product_id       uuid references public.products (id) on delete set null,
  description      text,
  default_status   text not null default 'unpaid' check (default_status in ('paid', 'unpaid', 'partial')),
  is_active        boolean not null default true,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (frequency <> 'custom' or interval_days is not null)
);

create trigger recurring_expenses_updated_at before update on public.recurring_expenses
  for each row execute function public.tg_set_updated_at();
create trigger recurring_expenses_audit after insert or update or delete on public.recurring_expenses
  for each row execute function public.tg_audit_row();

create table public.expenses (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  category_id        uuid not null references public.expense_categories (id),
  amount             numeric(12, 2) not null check (amount >= 0),  -- DZD
  amount_paid        numeric(12, 2) not null default 0 check (amount_paid >= 0),
  expense_date       date not null,
  description        text,
  payment_method     text,
  payee              text,
  reference          text,
  attachment_path    text,  -- storage object path (private bucket)
  payment_status     text not null default 'paid' check (payment_status in ('paid', 'unpaid', 'partial')),
  recurring_id       uuid references public.recurring_expenses (id) on delete set null,
  period_key         text,
  order_id           uuid references public.orders (id) on delete set null,
  product_id         uuid references public.products (id) on delete set null,
  employee_id        uuid references public.profiles (id) on delete set null,
  created_by         uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index expenses_recurring_period_uidx on public.expenses (recurring_id, period_key) where recurring_id is not null;
create index expenses_date_idx on public.expenses (expense_date);
create index expenses_category_idx on public.expenses (category_id, expense_date);

create trigger expenses_updated_at before update on public.expenses
  for each row execute function public.tg_set_updated_at();
create trigger expenses_audit after insert or update or delete on public.expenses
  for each row execute function public.tg_audit_row();

create or replace function public.next_recurrence(p_date date, p_frequency text, p_interval integer)
returns date language sql immutable as $$
  select case p_frequency
    when 'daily' then p_date + 1
    when 'weekly' then p_date + 7
    when 'monthly' then (p_date + interval '1 month')::date
    when 'yearly' then (p_date + interval '1 year')::date
    else p_date + coalesce(p_interval, 30)
  end
$$;

-- Idempotent generation: the unique (recurring_id, period_key) index makes a
-- second run (or a concurrent run) a no-op for periods already generated.
create or replace function public.generate_recurring_expenses(p_until date default current_date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r public.recurring_expenses;
  v_date date;
  v_count integer := 0;
  v_inserted integer;
begin
  for r in
    select * from public.recurring_expenses
    where is_active and next_run_date <= p_until
    for update skip locked
  loop
    v_date := r.next_run_date;
    while v_date <= p_until and (r.end_date is null or v_date <= r.end_date) loop
      insert into public.expenses (title, category_id, amount, amount_paid, expense_date, description, payment_method,
                                   payee, payment_status, recurring_id, period_key, employee_id, product_id, created_by)
      values (r.title, r.category_id, r.amount, case when r.default_status = 'paid' then r.amount else 0 end, v_date,
              r.description, r.payment_method, r.payee, r.default_status, r.id, to_char(v_date, 'YYYY-MM-DD'),
              r.employee_id, r.product_id, r.created_by)
      on conflict (recurring_id, period_key) where recurring_id is not null do nothing;
      get diagnostics v_inserted = row_count;
      v_count := v_count + v_inserted;
      v_date := public.next_recurrence(v_date, r.frequency, r.interval_days);
    end loop;
    update public.recurring_expenses
       set next_run_date = v_date,
           is_active = case when r.end_date is not null and v_date > r.end_date then false else is_active end
     where id = r.id;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Advertising (Meta Marketing API)
-- ---------------------------------------------------------------------------
create table public.ad_accounts (
  id               uuid primary key default gen_random_uuid(),
  platform         text not null default 'meta' check (platform in ('meta')),
  external_id      text not null,              -- act_XXXXXXXX
  connection_id    uuid,                       -- integration_connections.id
  name             text not null,
  currency         text not null default 'USD',
  timezone         text,
  fx_rate_to_dzd   numeric(14, 4),             -- required when currency <> DZD
  is_active        boolean not null default true,
  sync_from        date not null default (current_date - 30),
  last_synced_at   timestamptz,
  last_synced_date date,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (platform, external_id)
);

create trigger ad_accounts_updated_at before update on public.ad_accounts
  for each row execute function public.tg_set_updated_at();
create trigger ad_accounts_audit after insert or update or delete on public.ad_accounts
  for each row execute function public.tg_audit_row();

create table public.ad_insights_daily (
  id              bigint generated always as identity primary key,
  ad_account_id   uuid not null references public.ad_accounts (id) on delete cascade,
  date            date not null,             -- in the ad account's timezone (as returned by Meta)
  campaign_id     text,
  campaign_name   text,
  adset_id        text,
  adset_name      text,
  ad_id           text not null,
  ad_name         text,
  spend           numeric(14, 4) not null default 0, -- in account currency
  impressions     bigint not null default 0,
  reach           bigint,
  clicks          bigint not null default 0,
  cpm             numeric(14, 4),
  cpc             numeric(14, 4),
  ctr             numeric(10, 4),
  results         jsonb not null default '{}',   -- actions / conversions as returned
  currency        text not null,
  synced_at       timestamptz not null default now(),
  unique (ad_account_id, date, ad_id)
);
create index ad_insights_date_idx on public.ad_insights_daily (date);
create index ad_insights_campaign_idx on public.ad_insights_daily (campaign_id, date);

-- Spend converted to DZD; null when an FX rate is missing for a foreign account.
create view public.ad_spend_daily
with (security_invoker = true) as
  select i.*,
         case when i.currency = 'DZD' then i.spend
              when a.fx_rate_to_dzd is not null then round(i.spend * a.fx_rate_to_dzd, 2)
         end as spend_dzd,
         a.name as account_name
  from public.ad_insights_daily i
  join public.ad_accounts a on a.id = i.ad_account_id;

-- Manual allocation of advertising cost to products (allocation method "manual").
create table public.ad_manual_allocations (
  id            uuid primary key default gen_random_uuid(),
  period_start  date not null,
  period_end    date not null,
  product_id    uuid not null references public.products (id) on delete cascade,
  amount_dzd    numeric(12, 2) not null check (amount_dzd >= 0),
  note          text,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  check (period_end >= period_start)
);

-- Map campaigns to products for attribution when orders carry no ad id.
create table public.ad_campaign_products (
  campaign_id  text not null,
  product_id   uuid not null references public.products (id) on delete cascade,
  primary key (campaign_id, product_id)
);
