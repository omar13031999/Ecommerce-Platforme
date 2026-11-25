-- Google Sheets / external imports: incomplete rows are imported as they are
-- (placeholder name, empty phone, placeholder product) and flagged needs_review,
-- instead of being rejected. Re-syncs never overwrite values with blanks.
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


  -- Auto-assignment runs from the orders insert trigger (capacity engine).
  insert into public.orders (
    external_id, source, source_id, customer_name, phone, phone2, wilaya_code, wilaya_raw, commune, address,
    customer_notes, delivery_fee, delivery_type, ordered_at, total_override, total_amount,
    utm_source, utm_campaign, utm_content, meta_campaign_id, meta_adset_id, meta_ad_id, needs_review, review_reason)
  values (
    v_ext, p_source, p_source_id,
    coalesce(nullif(btrim(p_order ->> 'customer_name'), ''), 'Client sans nom'),
    coalesce(btrim(p_order ->> 'phone'), ''),
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
    nullif(p_order ->> 'meta_campaign_id', ''), nullif(p_order ->> 'meta_adset_id', ''), nullif(p_order ->> 'meta_ad_id', ''),
    coalesce((p_order ->> 'needs_review')::boolean, false), nullif(btrim(p_order ->> 'review_reason'), ''))
  returning * into o;

  -- Incomplete rows are imported as they are; confirmers complete the order.
  if jsonb_typeof(p_order -> 'items') is distinct from 'array' or jsonb_array_length(p_order -> 'items') = 0 then
    insert into public.order_items (order_id, product_name, quantity, unit_price)
    values (o.id, 'Produit non renseigné', 1, 0);
    return jsonb_build_object('action', 'created', 'order_id', o.id, 'unmatched', true);
  end if;

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
