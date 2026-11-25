-- Confirmer workspace: edit product lines during the call, edit customer notes,
-- and clear the "incomplete import" review flag automatically once completed.

-- Clears needs_review set by an incomplete import when the order is now complete.
create or replace function public.clear_import_review(p_order_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.orders o set needs_review = false, review_reason = null
   where o.id = p_order_id and o.needs_review and o.review_reason like 'Import incomplet%'
     and o.customer_name <> 'Client sans nom' and length(public.normalize_phone(o.phone)) >= 9
     and o.wilaya_code is not null
     and not exists (select 1 from public.order_items i where i.order_id = o.id and (i.product_name = 'Produit non renseigné' or i.unit_price = 0));
$$;

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
    delivery_type = case when p_patch ->> 'delivery_type' in ('home', 'stopdesk') then p_patch ->> 'delivery_type' else delivery_type end,
    customer_notes = case when p_patch ? 'customer_notes' then nullif(btrim(p_patch ->> 'customer_notes'), '') else customer_notes end
  where id = p_order_id;
  perform public.clear_import_review(p_order_id);
  select version into o.version from public.orders where id = p_order_id;
  return o.version;
end
$$;

-- Replaces the product lines of an order (same rules as update_order_customer).
-- p_items: [{ "id"?: uuid, "product_id"?: uuid, "product_name"?: text, "quantity": int, "unit_price": numeric }]
create or replace function public.update_order_items(p_order_id uuid, p_items jsonb, p_expected_version integer default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  v jsonb;
  v_id uuid;
  v_pid uuid;
  v_name text;
  v_sku text;
  v_keep uuid[] := '{}';
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
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  for v in select * from jsonb_array_elements(p_items) loop
    v_id := nullif(v ->> 'id', '')::uuid;
    v_pid := nullif(v ->> 'product_id', '')::uuid;
    v_name := nullif(btrim(v ->> 'product_name'), '');
    v_sku := null;
    if v_pid is not null then
      select name, sku into v_name, v_sku from public.products where id = v_pid and not is_archived;
      if not found then
        raise exception 'product_not_found' using errcode = '22023';
      end if;
    end if;
    if coalesce((v ->> 'quantity')::integer, 0) < 1 or coalesce((v ->> 'unit_price')::numeric, -1) < 0 then
      raise exception 'invalid_items' using errcode = '22023';
    end if;
    if v_id is not null and exists (select 1 from public.order_items where id = v_id and order_id = p_order_id) then
      update public.order_items set
        quantity = (v ->> 'quantity')::integer,
        unit_price = (v ->> 'unit_price')::numeric,
        product_id = coalesce(v_pid, product_id),
        product_name = coalesce(v_name, product_name),
        sku = case when v_pid is not null then v_sku else sku end
      where id = v_id;
      v_keep := v_keep || v_id;
    else
      if v_name is null then
        raise exception 'invalid_items' using errcode = '22023';
      end if;
      insert into public.order_items (order_id, product_id, product_name, sku, quantity, unit_price)
      values (p_order_id, v_pid, v_name, v_sku, (v ->> 'quantity')::integer, (v ->> 'unit_price')::numeric)
      returning id into v_id;
      v_keep := v_keep || v_id;
    end if;
  end loop;
  delete from public.order_items where order_id = p_order_id and not (id = any (v_keep));

  perform public.clear_import_review(p_order_id);
  select version into o.version from public.orders where id = p_order_id;
  return o.version;
end
$$;

revoke execute on function public.clear_import_review(uuid) from public, anon, authenticated;
grant execute on function public.update_order_items(uuid, jsonb, integer) to authenticated;
