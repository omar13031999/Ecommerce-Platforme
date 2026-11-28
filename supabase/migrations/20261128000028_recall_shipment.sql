-- Recall an order from the carrier while the parcel has not been picked up
-- (submitted / processing / ready_for_pickup): the active shipment is closed as
-- cancelled, the order goes back to "Confirmée — à envoyer" (not_submitted, no
-- tracking) and can be edited and sent again. Called by trusted server code
-- after the carrier deleted/cancelled the parcel (or, p_forced, after the owner
-- cancelled it by hand in the carrier panel).
create or replace function public.recall_shipment(p_order_id uuid, p_actor uuid, p_note text default null, p_forced boolean default false)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  sh public.delivery_shipments;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if o.delivery_status not in ('submitted', 'processing', 'ready_for_pickup', 'pending_submission') then
    raise exception 'recall_not_allowed' using errcode = '22023';
  end if;

  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  update public.delivery_shipments set is_active = false, status = 'cancelled',
         error_message = case when p_forced then 'recalled (cancelled manually at the carrier)' else 'recalled' end
   where order_id = p_order_id and is_active
   returning * into sh;

  if sh.id is not null then
    insert into public.delivery_events (shipment_id, order_id, provider_id, source, provider_status, internal_status, payload, dedupe_key, applied)
    values (sh.id, o.id, sh.provider_id, 'system', case when p_forced then 'recalled_manual' else 'recalled' end, 'not_submitted',
            jsonb_build_object('tracking', sh.tracking_number), 'recall:' || sh.id, true)
    on conflict (dedupe_key) do nothing;
  end if;

  update public.orders set delivery_status = 'not_submitted', delivery_status_at = now(),
         tracking_number = null, submitted_at = null
   where id = p_order_id;

  insert into public.order_notes (order_id, author_id, body)
  values (o.id, p_actor, left(
    'Commande récupérée du transporteur' || coalesce(' (colis ' || sh.tracking_number || ')', '')
    || case when p_forced then ' — annulée manuellement dans le panneau du transporteur' else '' end
    || coalesce(' : ' || nullif(btrim(p_note), ''), '') || '.', 4000));

  select version into o.version from public.orders where id = p_order_id;
  return o.version;
end
$$;

revoke execute on function public.recall_shipment(uuid, uuid, text, boolean) from public, anon, authenticated;
