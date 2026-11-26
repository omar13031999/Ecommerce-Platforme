-- =============================================================================
-- 0022 — Postponed orders with due-date notifications, owner-only order
-- deletion, and confirmers' default access (tracking + adding products).
-- =============================================================================

alter table public.orders
  add column if not exists postponed_until timestamptz,
  add column if not exists postpone_notified_at timestamptz;
create index if not exists orders_postponed_due_idx on public.orders (postponed_until)
  where confirmation_status = 'postponed' and postpone_notified_at is null;

-- Postpone: same permission and transition rules as any status change, plus the date.
create or replace function public.postpone_order(p_order_id uuid, p_until timestamptz, p_note text default null, p_expected_version integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb;
begin
  if p_until is null or p_until < now() - interval '5 minutes' or p_until > now() + interval '180 days' then
    raise exception 'invalid_postpone_date' using errcode = '22023';
  end if;
  r := public.set_confirmation_status(p_order_id, 'postponed', p_note, p_expected_version);
  update public.orders set postponed_until = p_until, postpone_notified_at = null where id = p_order_id;
  return r || jsonb_build_object('postponed_until', p_until,
    'version', (select version from public.orders where id = p_order_id));
end
$$;

-- Called by the scheduler: one notification per due postponed order
-- (assigned confirmer, or every order manager when nobody is assigned).
create or replace function public.notify_due_postponed(p_limit integer default 200)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  o record;
  n integer := 0;
begin
  for o in
    select id, reference, customer_name, assigned_to, postponed_until from public.orders
     where confirmation_status = 'postponed' and postpone_notified_at is null and postponed_until <= now()
     order by postponed_until limit p_limit
     for update skip locked
  loop
    if o.assigned_to is not null then
      insert into public.notifications (user_id, type, params, link)
      values (o.assigned_to, 'postponed_due', jsonb_build_object('reference', o.reference, 'customer', o.customer_name), '/orders/' || o.id);
    else
      perform public.notify_permission('orders.manage', 'postponed_due',
        jsonb_build_object('reference', o.reference, 'customer', o.customer_name), '/orders/' || o.id);
    end if;
    update public.orders set postpone_notified_at = now() where id = o.id;
    n := n + 1;
  end loop;
  return n;
end
$$;

-- Owner-only hard delete (admin role). History, items, shipments go with the order.
create or replace function public.delete_orders(p_order_ids uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(array_length(p_order_ids, 1), 0) = 0 or array_length(p_order_ids, 1) > 500 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before)
  select auth.uid(), 'delete', 'orders', o.id::text,
         jsonb_build_object('reference', o.reference, 'customer', o.customer_name, 'phone', o.phone,
                            'confirmation_status', o.confirmation_status, 'delivery_status', o.delivery_status, 'total', o.total_amount)
    from public.orders o where o.id = any (p_order_ids);
  delete from public.orders where id = any (p_order_ids);
  get diagnostics n = row_count;
  return n;
end
$$;

-- Confirmers: follow their parcels and add products (never edit/delete, never costs).
create or replace function public.role_default_permissions(p_role public.app_role)
returns text[] language sql immutable set search_path = '' as $$
  select case p_role
    when 'admin' then public.all_permissions()
    when 'manager' then array[
      'orders.view_all', 'orders.manage', 'orders.assign', 'orders.create', 'orders.export',
      'team.view', 'team.manage', 'delivery.view', 'delivery.manage', 'reports.operational', 'products.create'
    ]::text[]
    else array['delivery.view', 'products.create']::text[]
  end
$$;

create or replace function public.all_permissions()
returns text[] language sql immutable set search_path = '' as $$
  select array[
    'orders.view_all', 'orders.manage', 'orders.assign', 'orders.create', 'orders.export',
    'team.view', 'team.manage', 'delivery.view', 'delivery.manage', 'products.manage', 'products.create',
    'reports.operational', 'finance.view', 'finance.manage', 'expenses.manage', 'ads.view', 'ads.manage',
    'integrations.manage', 'settings.manage'
  ]::text[]
$$;

drop policy if exists products_insert on public.products;
create policy products_insert on public.products for insert to authenticated
  with check (public.has_permission('products.manage') or public.has_permission('products.create'));

revoke execute on function public.notify_due_postponed(integer) from public, anon, authenticated;
grant execute on function public.postpone_order(uuid, timestamptz, text, integer), public.delete_orders(uuid[]) to authenticated;
