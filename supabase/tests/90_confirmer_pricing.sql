\o /dev/null
\echo '--- confirmers adjust unit prices, delivery fee and discount; the total follows'
begin;
select tests.login(null);
create temp table ids as select tests.create_user('agent9@t', 'agent', true, 50) as a;
grant select on ids to authenticated;
-- Sheet order with a frozen total from the sheet
create temp table imp as select public.upsert_external_order('google_sheets', null,
  '{"external_id": "PR-1", "customer_name": "Karim", "phone": "0555123456", "total_amount": 6490, "delivery_fee": 500,
    "items": [{"product_name": "Tn Gold", "quantity": 1, "unit_price": 5990}]}'::jsonb) as r;
create temp table t as select (r ->> 'order_id')::uuid as o from imp;
grant select on t to authenticated;
update public.orders set assigned_to = (select a from ids) where id = (select o from t);
select tests.assert((select total_override and total_amount = 6490 from public.orders where id = (select o from t)), 'sheet total frozen');

-- The assigned confirmer gives a discount and changes the delivery fee
select tests.login((select a from ids));
set role authenticated;
select public.update_order_customer((select o from t), '{"delivery_fee": 400, "discount": 300}'::jsonb);
reset role;
select tests.login(null);
select tests.assert((select delivery_fee = 400 and discount = 300 and not total_override and total_amount = 5990 + 400 - 300
                       from public.orders where id = (select o from t)), 'fee + discount applied, total recomputed');

-- ... then lowers the unit price
select tests.login((select a from ids));
set role authenticated;
select public.update_order_items((select o from t), (select jsonb_agg(jsonb_build_object('id', id, 'quantity', 1, 'unit_price', 5500)) from public.order_items where order_id = (select o from t)));
reset role;
select tests.login(null);
select tests.assert((select total_amount = 5500 + 400 - 300 from public.orders where id = (select o from t)), 'unit price change reflected in total');

-- Refusals: negative fee, discount above the total
select tests.login((select a from ids));
set role authenticated;
do $$ begin
  perform public.update_order_customer((select o from t), '{"delivery_fee": -1}'::jsonb);
  raise exception 'ASSERTION FAILED: negative fee accepted';
exception when invalid_parameter_value then null;
end $$;
do $$ begin
  perform public.update_order_customer((select o from t), '{"discount": 999999}'::jsonb);
  raise exception 'ASSERTION FAILED: discount above total accepted';
exception when invalid_parameter_value then null;
end $$;
reset role;
select tests.login(null);
rollback;
\o
\echo ok
