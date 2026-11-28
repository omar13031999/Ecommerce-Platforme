-- AI re-extraction of sheet orders that were imported "scattered" (raw row or
-- wrong columns) and that no confirmer has worked on yet: still `new`, not
-- sent, still flagged needs_review. The AI result replaces the customer fields
-- and product lines (placeholders included). Service role only (sheet sync).
create or replace function public.ai_reimport_order(p_source_id uuid, p_order jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  v_item jsonb;
  v_total numeric := nullif(p_order ->> 'total_amount', '')::numeric;
begin
  perform set_config('app.actor_label', 'google_sheets_ai', true);
  select * into o from public.orders
   where source = 'google_sheets' and source_id = p_source_id
     and external_id = nullif(btrim(p_order ->> 'external_id'), '')
   for update;
  if not found then
    return jsonb_build_object('action', 'missing');
  end if;
  if o.confirmation_status <> 'new' or o.delivery_status <> 'not_submitted' or not o.needs_review then
    return jsonb_build_object('action', 'unchanged', 'order_id', o.id);
  end if;

  update public.orders set
    customer_name = coalesce(nullif(btrim(p_order ->> 'customer_name'), ''), customer_name),
    phone = coalesce(nullif(btrim(p_order ->> 'phone'), ''), phone),
    phone2 = coalesce(nullif(btrim(p_order ->> 'phone2'), ''), phone2),
    wilaya_code = coalesce(public.resolve_wilaya(p_order ->> 'wilaya'), wilaya_code),
    wilaya_raw = coalesce(nullif(p_order ->> 'wilaya', ''), wilaya_raw),
    commune = coalesce(nullif(btrim(p_order ->> 'commune'), ''), commune),
    address = coalesce(nullif(btrim(p_order ->> 'address'), ''), address),
    customer_notes = coalesce(nullif(btrim(p_order ->> 'customer_notes'), ''), customer_notes),
    delivery_type = case when p_order ->> 'delivery_type' = 'stopdesk' then 'stopdesk' else 'home' end,
    delivery_fee = coalesce(nullif(p_order ->> 'delivery_fee', '')::numeric, delivery_fee),
    total_override = v_total is not null,
    total_amount = coalesce(v_total, total_amount),
    needs_review = coalesce((p_order ->> 'needs_review')::boolean, false),
    review_reason = nullif(btrim(p_order ->> 'review_reason'), '')
  where id = o.id;

  if jsonb_typeof(p_order -> 'items') = 'array' and jsonb_array_length(p_order -> 'items') > 0 then
    delete from public.order_items where order_id = o.id;
    for v_item in select * from jsonb_array_elements(p_order -> 'items') loop
      insert into public.order_items (order_id, product_name, sku, variant, quantity, unit_price)
      values (o.id,
              coalesce(nullif(btrim(v_item ->> 'product_name'), ''), nullif(btrim(v_item ->> 'sku'), ''), '?'),
              nullif(btrim(v_item ->> 'sku'), ''),
              nullif(btrim(v_item ->> 'variant'), ''),
              greatest(coalesce(nullif(v_item ->> 'quantity', '')::integer, 1), 1),
              coalesce(nullif(v_item ->> 'unit_price', '')::numeric, 0));
    end loop;
  end if;

  return jsonb_build_object('action', 'reextracted', 'order_id', o.id,
    'unmatched', exists (select 1 from public.order_items where order_id = o.id and product_id is null));
end
$$;

revoke execute on function public.ai_reimport_order(uuid, jsonb) from public, anon, authenticated;
