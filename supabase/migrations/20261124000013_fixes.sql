-- =============================================================================
-- 0013 — Fix duplicate-order detection.
-- Generated columns (phone_normalized) are not yet computed in BEFORE INSERT
-- triggers, so normalise the phone explicitly.
-- =============================================================================
create or replace function public.tg_order_detect_duplicate()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_phone text := public.normalize_phone(new.phone);
begin
  if v_phone is not null then
    select o.id into new.possible_duplicate_of
    from public.orders o
    where o.phone_normalized = v_phone
      and o.id <> new.id
      and o.ordered_at > new.ordered_at - interval '7 days'
      and o.confirmation_status not in ('cancelled', 'duplicate')
    order by o.ordered_at desc
    limit 1;
  end if;
  return new;
end
$$;

revoke execute on function public.tg_order_detect_duplicate() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Deleting an order cascades to its items; the item trigger must not try to
-- refresh totals / write history for an order that no longer exists.
-- -----------------------------------------------------------------------------
create or replace function public.tg_order_item_after()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_cost numeric(12, 2);
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if not exists (select 1 from public.orders where id = v_order) then
    return null; -- parent order being deleted (cascade)
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.product_id is not null
     and (tg_op = 'INSERT' or old.product_id is distinct from new.product_id) then
    select pc.purchase_cost into v_cost from public.product_costs pc where pc.product_id = new.product_id;
    insert into public.order_item_costs (order_item_id, unit_cost, cost_source, captured_by)
    values (new.id, v_cost, 'snapshot', public.current_actor())
    on conflict (order_item_id) do update
      set unit_cost = excluded.unit_cost, cost_source = 'snapshot', captured_at = now(), captured_by = excluded.captured_by;
  elsif tg_op = 'INSERT' then
    insert into public.order_item_costs (order_item_id, unit_cost) values (new.id, null)
    on conflict do nothing;
  end if;

  perform public.refresh_order_totals(v_order);

  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, actor_id, actor_label, event_type, new_value)
    values (new.order_id, public.current_actor(), public.current_actor_label(), 'item_added',
            new.product_name || ' x' || new.quantity || ' @ ' || new.unit_price);
  elsif tg_op = 'UPDATE' then
    if (old.product_id, old.quantity, old.unit_price, old.product_name)
       is distinct from (new.product_id, new.quantity, new.unit_price, new.product_name) then
      insert into public.order_events (order_id, actor_id, actor_label, event_type, old_value, new_value, metadata)
      values (new.order_id, public.current_actor(), public.current_actor_label(), 'item_updated',
              old.product_name || ' x' || old.quantity || ' @ ' || old.unit_price,
              new.product_name || ' x' || new.quantity || ' @ ' || new.unit_price,
              jsonb_build_object('item_id', new.id, 'old_product_id', old.product_id, 'new_product_id', new.product_id));
    end if;
  else
    insert into public.order_events (order_id, actor_id, actor_label, event_type, old_value)
    values (old.order_id, public.current_actor(), public.current_actor_label(), 'item_removed',
            old.product_name || ' x' || old.quantity || ' @ ' || old.unit_price);
  end if;
  return null;
end
$$;

create or replace function public.tg_items_refresh_ops()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.orders where id = coalesce(new.order_id, old.order_id)) then
    perform public.refresh_order_operational_costs(coalesce(new.order_id, old.order_id));
  end if;
  return null;
end
$$;

revoke execute on function public.tg_order_item_after(), public.tg_items_refresh_ops() from public, anon, authenticated;
