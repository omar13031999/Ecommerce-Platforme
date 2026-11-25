\o /dev/null
\echo '--- incomplete imported orders are created, flagged, and never blanked by a resync'
begin;
select tests.login(null);
create temp table ids as select tests.create_user('owner5@t', 'admin') as admin, tests.create_user('agent5@t', 'agent', true, 50) as a;
grant select on ids to authenticated;

-- A row with only an id and a phone-less, nameless, productless content
create temp table imp as select public.upsert_external_order('google_sheets', null,
  '{"external_id": "GS-EMPTY-1", "customer_name": "", "phone": "", "items": [],
    "needs_review": true, "review_reason": "Import incomplet — à compléter : nom, téléphone, produit"}'::jsonb) as r;
grant select on imp to authenticated;
create temp table t as select (r ->> 'order_id')::uuid as o from imp;
grant select on t to authenticated;
select tests.assert((select r ->> 'action' from imp) = 'created', 'incomplete row imported');
select tests.assert((select customer_name = 'Client sans nom' and phone = '' and needs_review and review_reason like 'Import incomplet%'
                       from public.orders where id = (select o from t)), 'placeholder name, empty phone, flagged for review');
select tests.assert((select count(*) = 1 and bool_and(product_name = 'Produit non renseigné' and quantity = 1)
                       from public.order_items where order_id = (select o from t)), 'placeholder product line');
select tests.assert((select possible_duplicate_of is null from public.orders where id = (select o from t)), 'empty phone is not a duplicate');

-- A second empty-phone order must not be flagged as duplicate of the first
select public.upsert_external_order('google_sheets', null, '{"external_id": "GS-EMPTY-2", "customer_name": "B", "phone": "", "items": []}'::jsonb);
select tests.assert((select possible_duplicate_of is null from public.orders where external_id = 'GS-EMPTY-2'), 'two empty phones are not duplicates');

-- The confirmer completes the order; a resync with blank cells keeps the corrections
update public.orders set customer_name = 'Karim', phone = '0555123456' where id = (select o from t);
select public.upsert_external_order('google_sheets', null, '{"external_id": "GS-EMPTY-1", "customer_name": "", "phone": "", "items": []}'::jsonb);
select tests.assert((select customer_name = 'Karim' and phone = '0555123456' from public.orders where id = (select o from t)), 'resync does not erase corrections');
-- Confirmer workspace: the manager completes products, and the review flag clears
insert into public.products (id, sku, name, selling_price) values ('55555555-5555-5555-5555-555555555555', 'TG41', 'Tn Gold 41', 3500);
update public.orders set wilaya_code = 16 where id = (select o from t);
select tests.login((select admin from ids));
set role authenticated;
select public.update_order_items((select o from t), jsonb_build_array(
  jsonb_build_object('id', (select id from public.order_items where order_id = (select o from t) limit 1),
                     'product_id', '55555555-5555-5555-5555-555555555555', 'quantity', 2, 'unit_price', 3500)));
reset role;
select tests.login(null);
select tests.assert((select count(*) = 1 and bool_and(product_name = 'Tn Gold 41' and sku = 'TG41' and quantity = 2 and product_id is not null)
                       from public.order_items where order_id = (select o from t)), 'line replaced by catalogue product');
select tests.assert((select subtotal = 7000 from public.orders where id = (select o from t)), 'totals recomputed');
select tests.assert((select not needs_review and review_reason is null from public.orders where id = (select o from t)), 'import review cleared once complete');

-- Add a free-text line and remove nothing else; then an unassigned agent is refused
select tests.login((select admin from ids));
set role authenticated;
select public.update_order_items((select o from t), (select jsonb_agg(jsonb_build_object('id', id, 'quantity', quantity, 'unit_price', unit_price)) from public.order_items where order_id = (select o from t))
  || jsonb_build_array(jsonb_build_object('product_name', 'Cadeau', 'quantity', 1, 'unit_price', 0)));
reset role;
select tests.login(null);
select tests.assert((select count(*) = 2 from public.order_items where order_id = (select o from t)), 'line added');
update public.orders set assigned_to = null where id = (select o from t);
select tests.login((select a from ids));
set role authenticated;
do $$ begin
  perform public.update_order_items((select o from t), '[{"product_name": "X", "quantity": 1, "unit_price": 1}]'::jsonb);
  raise exception 'ASSERTION FAILED: agent edited an order not assigned to them';
exception when insufficient_privilege then null;
end $$;
reset role;
select tests.login(null);
rollback;
\o
\echo ok
