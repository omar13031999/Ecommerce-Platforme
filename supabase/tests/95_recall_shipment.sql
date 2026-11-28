\o /dev/null
\echo '--- recall an order from the carrier before pickup, then send it again'
begin;
select tests.login(null);
create temp table ids as select tests.create_user('owner95@t', 'admin') as admin;
grant select on ids to authenticated;
insert into public.delivery_providers (id, code, name) values ('95959595-9595-9595-9595-959595959595', 'manual', 'Livreur 95');
create temp table imp as select public.upsert_external_order('google_sheets', null,
  '{"external_id": "RC-1", "customer_name": "Karim", "phone": "0555123456", "wilaya": "16", "commune": "Kouba",
    "items": [{"product_name": "Montre", "quantity": 1, "unit_price": 4500}]}'::jsonb) as r;
create temp table t as select (r ->> 'order_id')::uuid as o from imp;
grant select on t to authenticated;
select tests.login((select admin from ids)); set role authenticated;
select public.set_confirmation_status((select o from t), 'confirmed');
reset role; select tests.login(null);

create temp table sh as select * from public.claim_shipment_submission((select o from t), '95959595-9595-9595-9595-959595959595', null);
select public.complete_shipment_submission((select id from sh), 'TRK-95', null, 'REF', null, '{}', '{}', null);
select tests.assert((select delivery_status = 'submitted' and tracking_number = 'TRK-95' from public.orders where id = (select o from t)), 'sent');

select public.recall_shipment((select o from t), (select admin from ids), 'changer la taille');
select tests.assert((select delivery_status = 'not_submitted' and tracking_number is null and confirmation_status = 'confirmed'
                       from public.orders where id = (select o from t)), 'back to confirmed, not sent');
select tests.assert((select not is_active and status = 'cancelled' from public.delivery_shipments where id = (select id from sh)), 'old parcel closed');
select tests.assert((select count(*) = 1 from public.order_notes where order_id = (select o from t) and body like 'Commande récupérée%TRK-95%changer la taille%'), 'note left');

-- Editable again, and a new submission gets a new parcel
select tests.login((select admin from ids)); set role authenticated;
select public.update_order_items((select o from t), (select jsonb_agg(jsonb_build_object('id', id, 'quantity', 2, 'unit_price', 4000)) from public.order_items where order_id = (select o from t)));
reset role; select tests.login(null);
create temp table sh2 as select * from public.claim_shipment_submission((select o from t), '95959595-9595-9595-9595-959595959595', null);
select tests.assert((select id from sh2) <> (select id from sh) and (select idempotency_key from sh2) <> (select idempotency_key from sh), 'new parcel, new reference');

-- Not after pickup, and not callable by app users
select public.complete_shipment_submission((select id from sh2), 'TRK-96', null, 'REF2', null, '{}', '{}', null);
update public.orders set delivery_status = 'picked_up' where id = (select o from t);
do $$ begin
  perform public.recall_shipment((select o from t), null);
  raise exception 'ASSERTION FAILED: recall after pickup';
exception when invalid_parameter_value then null;
end $$;
do $$ begin
  set local role authenticated;
  perform public.recall_shipment((select o from t), null);
  raise exception 'ASSERTION FAILED: authenticated can call recall_shipment';
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
\o
\echo ok
