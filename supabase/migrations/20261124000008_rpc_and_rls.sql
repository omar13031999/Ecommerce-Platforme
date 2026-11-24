-- =============================================================================
-- 0008 — User-facing RPCs, Row Level Security and privileges
--
-- Principle: financial data lives in dedicated tables (product_costs,
-- order_item_costs, order_financials, cod_settlements, expenses*, ad_*,
-- delivery_rates, delivery_shipments raw responses) whose policies require
-- finance/ads/delivery permissions. Agents can only reach their assigned
-- orders, and only through policies evaluated by PostgreSQL — never by UI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Manual order creation (orders.create)
create or replace function public.create_order(p_order jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_item jsonb;
begin
  if not public.has_permission('orders.create') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_order -> 'items') <> 'array' or jsonb_array_length(p_order -> 'items') = 0 then
    raise exception 'missing_items' using errcode = '22023';
  end if;

  insert into public.orders (source, customer_name, phone, phone2, wilaya_code, commune, address, delivery_type,
                             customer_notes, delivery_fee, discount, ordered_at)
  values ('manual',
          btrim(p_order ->> 'customer_name'), btrim(p_order ->> 'phone'), nullif(btrim(p_order ->> 'phone2'), ''),
          nullif(p_order ->> 'wilaya_code', '')::smallint, nullif(btrim(p_order ->> 'commune'), ''),
          nullif(btrim(p_order ->> 'address'), ''),
          case when p_order ->> 'delivery_type' = 'stopdesk' then 'stopdesk' else 'home' end,
          nullif(btrim(p_order ->> 'customer_notes'), ''),
          coalesce(nullif(p_order ->> 'delivery_fee', '')::numeric, 0),
          coalesce(nullif(p_order ->> 'discount', '')::numeric, 0),
          now())
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_order -> 'items') loop
    insert into public.order_items (order_id, product_id, product_name, sku, quantity, unit_price)
    select v_id, p.id, coalesce(p.name, v_item ->> 'product_name'), p.sku,
           greatest(coalesce((v_item ->> 'quantity')::integer, 1), 1),
           coalesce(nullif(v_item ->> 'unit_price', '')::numeric, p.selling_price, 0)
    from (select 1) d
    left join public.products p on p.id = nullif(v_item ->> 'product_id', '')::uuid;
  end loop;
  return v_id;
end
$$;

-- Customer data corrections by the assigned agent (or managers) during confirmation.
create or replace function public.update_order_customer(p_order_id uuid, p_patch jsonb, p_expected_version integer default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
begin
  if not public.is_active_user() then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if not public.has_permission('orders.manage') and o.assigned_to is distinct from auth.uid() then
    raise exception 'not_assigned' using errcode = '42501';
  end if;
  if p_expected_version is not null and o.version <> p_expected_version then
    raise exception 'stale_version' using errcode = '40001';
  end if;
  if o.delivery_status not in ('not_submitted', 'submission_failed') then
    raise exception 'order_in_delivery' using errcode = '22023';
  end if;

  update public.orders set
    customer_name = case when p_patch ? 'customer_name' and length(btrim(p_patch ->> 'customer_name')) > 0
                         then btrim(p_patch ->> 'customer_name') else customer_name end,
    phone = case when p_patch ? 'phone' and length(btrim(p_patch ->> 'phone')) > 0 then btrim(p_patch ->> 'phone') else phone end,
    phone2 = case when p_patch ? 'phone2' then nullif(btrim(p_patch ->> 'phone2'), '') else phone2 end,
    wilaya_code = case when p_patch ? 'wilaya_code' then nullif(p_patch ->> 'wilaya_code', '')::smallint else wilaya_code end,
    commune = case when p_patch ? 'commune' then nullif(btrim(p_patch ->> 'commune'), '') else commune end,
    address = case when p_patch ? 'address' then nullif(btrim(p_patch ->> 'address'), '') else address end,
    delivery_type = case when p_patch ->> 'delivery_type' in ('home', 'stopdesk') then p_patch ->> 'delivery_type' else delivery_type end
  where id = p_order_id
  returning version into o.version;
  return o.version;
end
$$;

-- Manual product matching for an order line (optionally remember as alias)
create or replace function public.match_order_item(p_item_id uuid, p_product_id uuid, p_remember boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  i public.order_items;
begin
  if not (public.has_permission('products.manage') or public.has_permission('orders.manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into i from public.order_items where id = p_item_id for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  update public.order_items set product_id = p_product_id, match_status = 'manual' where id = p_item_id;
  if p_remember then
    insert into public.product_aliases (product_id, alias, created_by)
    values (p_product_id, coalesce(nullif(i.sku, ''), i.product_name), auth.uid())
    on conflict (alias_normalized) do update set product_id = excluded.product_id;
    -- Apply the new rule to other unmatched lines with the same label
    update public.order_items set product_id = p_product_id, match_status = 'matched'
     where product_id is null
       and public.normalize_text(coalesce(nullif(sku, ''), product_name)) = public.normalize_text(coalesce(nullif(i.sku, ''), i.product_name));
  end if;
end
$$;

-- Explicit, audited recalculation of historical cost snapshots.
create or replace function public.recalculate_item_costs(p_product_id uuid, p_from date, p_to date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_cost numeric;
  v_count integer;
begin
  if not public.has_permission('finance.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select purchase_cost into v_cost from public.product_costs where product_id = p_product_id;
  update public.order_item_costs c
     set unit_cost = v_cost, cost_source = 'recalculated', captured_at = now(), captured_by = auth.uid()
    from public.order_items i
    join public.orders o on o.id = i.order_id
   where c.order_item_id = i.id
     and i.product_id = p_product_id
     and o.ordered_at::date between p_from and p_to;
  get diagnostics v_count = row_count;
  perform public.log_audit('recalculate_costs', 'products', p_product_id::text, null,
    jsonb_build_object('from', p_from, 'to', p_to, 'unit_cost', v_cost, 'rows', v_count));
  return v_count;
end
$$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
$$;

create or replace function public.set_my_locale(p_locale public.app_locale)
returns void
language sql security definer set search_path = ''
as $$
  update public.profiles set locale = p_locale where id = auth.uid()
$$;

-- Names of colleagues (for history display). No sensitive columns.
create view public.staff_directory
with (security_invoker = false) as
  select p.id, p.full_name, p.role, p.is_active
  from public.profiles p
  where public.is_active_user();

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'app_settings', 'audit_logs', 'notifications', 'job_leases', 'sync_runs',
    'wilayas', 'products', 'product_costs', 'product_cost_history', 'product_aliases',
    'delivery_providers', 'delivery_rates',
    'orders', 'order_items', 'order_item_costs', 'order_events', 'order_notes', 'order_assignments', 'order_redistributions',
    'delivery_shipments', 'delivery_events', 'delivery_status_mappings', 'webhook_inbox',
    'order_financials', 'cod_settlements', 'expense_categories', 'recurring_expenses', 'expenses',
    'ad_accounts', 'ad_insights_daily', 'ad_manual_allocations', 'ad_campaign_products',
    'integration_connections', 'integration_secrets', 'oauth_states', 'sheet_sources', 'sheet_import_errors'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- Helper: can the current user see this order?
create or replace function public.can_view_order(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.has_permission('orders.view_all')
      or exists (select 1 from public.orders o
                 where o.id = p_order_id and o.assigned_to = auth.uid() and public.is_active_user())
$$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_permission('team.view'));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- settings
create policy app_settings_select on public.app_settings for select to authenticated
  using (public.has_permission('settings.manage')
         or (scope = 'operational' and public.has_permission('orders.assign'))
         or (scope = 'financial' and public.has_permission('finance.view')));
create policy app_settings_update on public.app_settings for update to authenticated
  using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (public.has_permission('settings.manage'));

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

create policy sync_runs_select on public.sync_runs for select to authenticated
  using (public.has_permission('integrations.manage')
         or (kind in ('delivery_poll', 'delivery_submit') and public.has_permission('delivery.view'))
         or (kind in ('assignment', 'redistribution', 'google_sheets') and public.has_permission('orders.assign'))
         or (kind in ('meta_ads') and public.has_permission('ads.view'))
         or (kind in ('recurring_expenses', 'settlement_import') and public.has_permission('finance.view')));

-- reference data
create policy wilayas_select on public.wilayas for select to authenticated using (true);

-- products (non-confidential columns)
create policy products_select on public.products for select to authenticated using (public.is_active_user());
create policy products_insert on public.products for insert to authenticated with check (public.has_permission('products.manage'));
create policy products_update on public.products for update to authenticated
  using (public.has_permission('products.manage')) with check (public.has_permission('products.manage'));
create policy products_delete on public.products for delete to authenticated using (public.has_permission('settings.manage'));

create policy product_aliases_select on public.product_aliases for select to authenticated
  using (public.has_permission('products.manage') or public.has_permission('orders.manage'));
create policy product_aliases_write on public.product_aliases for all to authenticated
  using (public.has_permission('products.manage')) with check (public.has_permission('products.manage'));

-- product costs (CONFIDENTIAL)
create policy product_costs_select on public.product_costs for select to authenticated
  using (public.has_permission('finance.view'));
create policy product_costs_write on public.product_costs for update to authenticated
  using (public.has_permission('finance.manage')) with check (public.has_permission('finance.manage'));
create policy product_costs_insert on public.product_costs for insert to authenticated
  with check (public.has_permission('finance.manage'));
create policy product_cost_history_select on public.product_cost_history for select to authenticated
  using (public.has_permission('finance.view'));

-- delivery providers & tariffs
create policy delivery_providers_select on public.delivery_providers for select to authenticated
  using (public.has_permission('delivery.view'));
create policy delivery_providers_write on public.delivery_providers for all to authenticated
  using (public.has_permission('integrations.manage')) with check (public.has_permission('integrations.manage'));
create policy delivery_rates_select on public.delivery_rates for select to authenticated
  using (public.has_permission('finance.view'));
create policy delivery_rates_write on public.delivery_rates for all to authenticated
  using (public.has_permission('finance.manage')) with check (public.has_permission('finance.manage'));

-- orders
create policy orders_select on public.orders for select to authenticated
  using (public.has_permission('orders.view_all') or (assigned_to = auth.uid() and public.is_active_user()));
create policy orders_update on public.orders for update to authenticated
  using (public.has_permission('orders.manage')) with check (public.has_permission('orders.manage'));
create policy orders_delete on public.orders for delete to authenticated
  using (public.has_permission('settings.manage'));
-- (inserts go through create_order / upsert_external_order)

create policy order_items_select on public.order_items for select to authenticated
  using (public.can_view_order(order_id));
create policy order_items_write on public.order_items for all to authenticated
  using (public.has_permission('orders.manage')) with check (public.has_permission('orders.manage'));

create policy order_item_costs_select on public.order_item_costs for select to authenticated
  using (public.has_permission('finance.view'));
create policy order_item_costs_update on public.order_item_costs for update to authenticated
  using (public.has_permission('finance.manage')) with check (public.has_permission('finance.manage'));

create policy order_events_select on public.order_events for select to authenticated
  using (public.can_view_order(order_id));

create policy order_notes_select on public.order_notes for select to authenticated
  using (public.can_view_order(order_id));
create policy order_notes_insert on public.order_notes for insert to authenticated
  with check (author_id = auth.uid()
              and (public.has_permission('orders.manage')
                   or exists (select 1 from public.orders o where o.id = order_id and o.assigned_to = auth.uid()))
              and public.is_active_user());

create policy order_assignments_select on public.order_assignments for select to authenticated
  using (public.has_permission('orders.view_all') or agent_id = auth.uid());
create policy order_redistributions_select on public.order_redistributions for select to authenticated
  using (public.has_permission('orders.view_all') or to_agent_id = auth.uid());

-- delivery operations
create policy delivery_shipments_select on public.delivery_shipments for select to authenticated
  using (public.has_permission('delivery.view'));
create policy delivery_events_select on public.delivery_events for select to authenticated
  using (public.has_permission('delivery.view'));
create policy delivery_status_mappings_select on public.delivery_status_mappings for select to authenticated
  using (public.has_permission('delivery.view'));
create policy delivery_status_mappings_write on public.delivery_status_mappings for all to authenticated
  using (public.has_permission('delivery.manage')) with check (public.has_permission('delivery.manage'));
create policy webhook_inbox_select on public.webhook_inbox for select to authenticated
  using (public.has_permission('integrations.manage'));

-- finance (CONFIDENTIAL)
create policy order_financials_select on public.order_financials for select to authenticated
  using (public.has_permission('finance.view'));
create policy order_financials_update on public.order_financials for update to authenticated
  using (public.has_permission('finance.manage')) with check (public.has_permission('finance.manage'));

create policy cod_settlements_select on public.cod_settlements for select to authenticated
  using (public.has_permission('finance.view'));
create policy cod_settlements_write on public.cod_settlements for all to authenticated
  using (public.has_permission('finance.manage')) with check (public.has_permission('finance.manage'));

create policy expense_categories_select on public.expense_categories for select to authenticated
  using (public.has_permission('finance.view') or public.has_permission('expenses.manage'));
create policy expense_categories_write on public.expense_categories for all to authenticated
  using (public.has_permission('expenses.manage')) with check (public.has_permission('expenses.manage'));

create policy expenses_select on public.expenses for select to authenticated
  using (public.has_permission('finance.view') or public.has_permission('expenses.manage'));
create policy expenses_write on public.expenses for all to authenticated
  using (public.has_permission('expenses.manage')) with check (public.has_permission('expenses.manage'));

create policy recurring_expenses_select on public.recurring_expenses for select to authenticated
  using (public.has_permission('finance.view') or public.has_permission('expenses.manage'));
create policy recurring_expenses_write on public.recurring_expenses for all to authenticated
  using (public.has_permission('expenses.manage')) with check (public.has_permission('expenses.manage'));

-- advertising (CONFIDENTIAL)
create policy ad_accounts_select on public.ad_accounts for select to authenticated
  using (public.has_permission('ads.view') or public.has_permission('finance.view'));
create policy ad_accounts_update on public.ad_accounts for update to authenticated
  using (public.has_permission('ads.manage')) with check (public.has_permission('ads.manage'));
create policy ad_insights_select on public.ad_insights_daily for select to authenticated
  using (public.has_permission('ads.view') or public.has_permission('finance.view'));
create policy ad_manual_allocations_select on public.ad_manual_allocations for select to authenticated
  using (public.has_permission('ads.view') or public.has_permission('finance.view'));
create policy ad_manual_allocations_write on public.ad_manual_allocations for all to authenticated
  using (public.has_permission('ads.manage')) with check (public.has_permission('ads.manage'));
create policy ad_campaign_products_select on public.ad_campaign_products for select to authenticated
  using (public.has_permission('ads.view') or public.has_permission('finance.view'));
create policy ad_campaign_products_write on public.ad_campaign_products for all to authenticated
  using (public.has_permission('ads.manage')) with check (public.has_permission('ads.manage'));

-- integrations (secrets & oauth_states: NO policies -> service role only)
create policy integration_connections_select on public.integration_connections for select to authenticated
  using (public.has_permission('integrations.manage'));
create policy sheet_sources_select on public.sheet_sources for select to authenticated
  using (public.has_permission('integrations.manage'));
create policy sheet_sources_write on public.sheet_sources for all to authenticated
  using (public.has_permission('integrations.manage')) with check (public.has_permission('integrations.manage'));
create policy sheet_import_errors_select on public.sheet_import_errors for select to authenticated
  using (public.has_permission('integrations.manage') or public.has_permission('orders.manage'));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Profiles: users may only edit their own display fields; everything sensitive
-- goes through update_staff_member().
revoke update on public.profiles from authenticated;
grant update (full_name, phone, locale) on public.profiles to authenticated;
revoke insert, delete on public.profiles from authenticated;

-- Orders: workflow columns (status, assignment, delivery, flags) can only change
-- through the RPCs above, which validate transitions and keep history.
revoke insert, update on public.orders from authenticated;
grant update (customer_name, phone, phone2, wilaya_code, commune, address, delivery_type, customer_notes,
              delivery_fee, discount, utm_source, utm_campaign, utm_content,
              meta_campaign_id, meta_adset_id, meta_ad_id) on public.orders to authenticated;
revoke update on public.order_item_costs from authenticated;
grant update (unit_cost, cost_source) on public.order_item_costs to authenticated;
revoke insert, delete on public.order_item_costs, public.order_financials from authenticated;

-- Append-only tables
revoke insert, update, delete on public.order_events, public.audit_logs, public.order_assignments,
  public.order_redistributions, public.delivery_events, public.webhook_inbox, public.sync_runs,
  public.product_cost_history, public.job_leases from authenticated;
revoke all on public.integration_secrets, public.oauth_states from authenticated;
revoke insert, delete on public.notifications from authenticated;
revoke update on public.notifications from authenticated;

grant select on public.staff_directory, public.delivery_provider_directory to authenticated;
