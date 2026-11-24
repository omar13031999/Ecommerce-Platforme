\o /dev/null
\echo '--- delivery state machine, COD reconciliation, profit & expenses'
begin;
select tests.login(null);
create temp table ids as select tests.create_user('owner@t', 'admin') as admin, tests.create_user('a@t', 'agent', true, 50) as a;
grant select on ids to authenticated;
update public.app_settings set value = '{"confirmation_cost": 100, "packaging_cost": 50, "storage_cost": 0, "other_cost": 0}' where key = 'operational_costs';

insert into public.products (id, sku, name, selling_price) values ('22222222-2222-2222-2222-222222222222', 'CAM-01', 'Caméra', 6000);
update public.product_costs set purchase_cost = 2500 where product_id = '22222222-2222-2222-2222-222222222222';
insert into public.delivery_providers (id, code, name) values ('33333333-3333-3333-3333-333333333333', 'manual', 'Livreur Test');
insert into public.delivery_rates (provider_id, wilaya_code, home_cost, stopdesk_cost, return_cost)
  values ('33333333-3333-3333-3333-333333333333', 16, 400, 250, 200);

-- Import an order from an external source (multi-product, alias matching)
insert into public.product_aliases (product_id, alias) values ('22222222-2222-2222-2222-222222222222', 'camera wifi 360');
create temp table imp as select public.upsert_external_order('google_sheets', null, '{
  "external_id": "GS-1001", "customer_name": "Amine", "phone": "+213 555 12 34 56", "wilaya": "16 - Alger",
  "commune": "Bab Ezzouar", "address": "Cité 1", "delivery_fee": "500",
  "items": [{"product_name": "Caméra WIFI 360", "quantity": "2", "unit_price": "6000"},
            {"product_name": "Produit inconnu", "quantity": "1", "unit_price": "1000"}]}'::jsonb) as r;
grant select on imp to authenticated;
create temp table t as select (r ->> 'order_id')::uuid as o from imp;
grant select on t to authenticated;
select tests.assert((select r ->> 'action' from imp) = 'created', 'imported');
select tests.assert((select phone_normalized from public.orders where id = (select o from t)) = '0555123456', 'phone normalised');
select tests.assert((select wilaya_code from public.orders where id = (select o from t)) = 16, 'wilaya resolved');
select tests.assert((select subtotal = 13000 and total_amount = 13500 from public.orders where id = (select o from t)), 'totals computed');
select tests.assert((select has_unmatched_items from public.orders where id = (select o from t)), 'unknown product flagged unmatched');
select tests.assert((select count(*) from public.order_item_costs c join public.order_items i on i.id = c.order_item_id
                     where i.order_id = (select o from t) and c.unit_cost is null) = 1, 'unmatched line has unknown (not zero) cost');

-- Re-import: idempotent, does not overwrite status/notes
select public.upsert_external_order('google_sheets', null, '{"external_id": "GS-1001", "customer_name": "Amine B.", "phone": "0555123456", "items": [{"product_name":"x","quantity":1,"unit_price":1}]}'::jsonb);
select tests.assert((select count(*) from public.orders where external_id = 'GS-1001') = 1, 'no duplicate import');
select tests.assert((select customer_name from public.orders where id = (select o from t)) = 'Amine B.', 'customer field updated while new');
select tests.assert((select count(*) from public.order_items where order_id = (select o from t)) = 2, 'items untouched on re-import');

-- Profit is incomplete while a product cost is unknown
select tests.login((select admin from ids)); set role authenticated;
select public.set_confirmation_status((select o from t), 'confirmed');
select tests.assert((select profit_incomplete and gross_profit is null from public.order_profit where order_id = (select o from t)), 'unknown cost => no fake profit');
-- Manual match of the unknown line, then give it a cost
insert into public.products (id, name, selling_price) values ('44444444-4444-4444-4444-444444444444', 'Support', 1000);
update public.product_costs set purchase_cost = 300 where product_id = '44444444-4444-4444-4444-444444444444';
select public.match_order_item((select id from public.order_items where order_id = (select o from t) and product_id is null), '44444444-4444-4444-4444-444444444444', true);
select tests.assert(not (select has_unmatched_items from public.orders where id = (select o from t)), 'manual match clears flag');
select tests.assert(exists (select 1 from public.product_aliases where alias = 'Produit inconnu'), 'alias remembered');
reset role; select tests.login(null);

-- Delivery submission state machine with idempotency key
create temp table sh as select * from public.claim_shipment_submission((select o from t), '33333333-3333-3333-3333-333333333333', null);
grant select on sh to authenticated;
select tests.assert((select delivery_status from public.orders where id = (select o from t)) = 'pending_submission', 'pending submission');
do $$ begin
  perform public.claim_shipment_submission((select o from t), '33333333-3333-3333-3333-333333333333', null);
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'submission_in_progress' then raise; end if; end $$;
-- Ambiguous (timeout) -> unknown: next claim returns the same shipment (no blind re-create)
select public.fail_shipment_submission((select id from sh), true, 'timeout', 'timeout', null, null, null);
select tests.assert((select id from public.claim_shipment_submission((select o from t), '33333333-3333-3333-3333-333333333333', null)) = (select id from sh), 'ambiguous attempt must be reconciled, not duplicated');
select public.complete_shipment_submission((select id from sh), 'TRK-1', 'P-1', 'ORD-REF', null, '{}', '{"ok":true}', null);
select tests.assert((select delivery_status = 'submitted' and tracking_number = 'TRK-1' from public.orders where id = (select o from t)), 'submitted');
select tests.assert((select estimated_delivery_cost from public.order_financials where order_id = (select o from t)) = 400, 'delivery cost estimated from tariff');
do $$ begin
  perform public.claim_shipment_submission((select o from t), '33333333-3333-3333-3333-333333333333', null);
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'order_already_submitted' then raise; end if; end $$;

-- Tracking events: idempotent & out-of-order safe
select tests.assert(public.apply_delivery_event((select o from t), (select id from sh), '33333333-3333-3333-3333-333333333333', 'webhook', 'En transit', 'in_transit', now() - interval '2 hours', '{}', 'evt-1'), 'in transit applied');
select tests.assert(not public.apply_delivery_event((select o from t), (select id from sh), '33333333-3333-3333-3333-333333333333', 'webhook', 'En transit', 'in_transit', now() - interval '2 hours', '{}', 'evt-1'), 'duplicate webhook ignored');
select tests.assert(public.apply_delivery_event((select o from t), (select id from sh), '33333333-3333-3333-3333-333333333333', 'poll', 'Livré', 'delivered', now() - interval '1 hour', '{}', 'evt-2'), 'delivered applied');
select tests.assert(not public.apply_delivery_event((select o from t), (select id from sh), '33333333-3333-3333-3333-333333333333', 'poll', 'En transit', 'in_transit', now() - interval '3 hours', '{}', 'evt-0'), 'older event does not regress status');
select tests.assert((select delivery_status from public.orders where id = (select o from t)) = 'delivered', 'still delivered');
select tests.assert((select count(*) from public.delivery_events where order_id = (select o from t)) = 4, 'all events kept for traceability');

-- Delivered is NOT settled: settlement opened as pending, profit is "expected"
select tests.login((select admin from ids)); set role authenticated;
select tests.assert((select status from public.cod_settlements where order_id = (select o from t)) = 'pending', 'settlement pending');
select tests.assert((select bucket from public.order_profit where order_id = (select o from t)) = 'delivered_unsettled', 'delivered but unsettled');
-- revenue 13000 + fee 500 - cost (2*2500 + 300) - delivery 400 - ops (100+50) = 7650
select tests.assert((select gross_profit from public.order_profit where order_id = (select o from t)) = 7650, 'gross profit formula');
update public.cod_settlements set collected_amount = 13500, provider_fees = 400, transferred_amount = 13100,
  transfer_date = current_date, payment_reference = 'VIR-01' where order_id = (select o from t);
select tests.assert((select status from public.cod_settlements where order_id = (select o from t)) = 'transferred', 'settled');
select tests.assert((select bucket from public.order_profit where order_id = (select o from t)) = 'realized', 'realized after settlement');

-- Historical snapshot is not rewritten when the current cost changes
update public.product_costs set purchase_cost = 9999 where product_id = '22222222-2222-2222-2222-222222222222';
select tests.assert((select gross_profit from public.order_profit where order_id = (select o from t)) = 7650, 'snapshot preserved');
select tests.assert(public.recalculate_item_costs('22222222-2222-2222-2222-222222222222', current_date - 1, current_date + 1) = 1, 'explicit recalculation');
update public.product_costs set purchase_cost = 2500 where product_id = '22222222-2222-2222-2222-222222222222';
select public.recalculate_item_costs('22222222-2222-2222-2222-222222222222', current_date - 1, current_date + 1);

-- Expenses: overhead deducted, informational not; recurring generation idempotent
insert into public.expenses (title, category_id, amount, expense_date)
  select 'Loyer', id, 1000, current_date from public.expense_categories where name = 'Frais de bureau';
insert into public.expenses (title, category_id, amount, expense_date)
  select 'Recharge Meta', id, 99999, current_date from public.expense_categories where name = 'Publicité Meta';
reset role; select tests.login(null);
insert into public.ad_accounts (id, external_id, name, currency, fx_rate_to_dzd) values ('55555555-5555-5555-5555-555555555555', 'act_1', 'Compte 1', 'USD', 250);
insert into public.ad_insights_daily (ad_account_id, date, campaign_id, ad_id, spend, currency) values
  ('55555555-5555-5555-5555-555555555555', public.local_date(now()), 'c1', 'ad1', 10, 'USD');
insert into public.recurring_expenses (title, category_id, amount, frequency, start_date, next_run_date)
  select 'Abonnement', id, 300, 'daily', current_date - 2, current_date - 2 from public.expense_categories where name = 'Internet';
select tests.assert(public.generate_recurring_expenses(current_date) = 3, 'three daily occurrences generated');
select tests.assert(public.generate_recurring_expenses(current_date) = 0, 'second run generates nothing');
update public.recurring_expenses set next_run_date = current_date - 2;
select tests.assert(public.generate_recurring_expenses(current_date) = 0, 'even when rewound: unique period key prevents duplicates');

select tests.login((select admin from ids)); set role authenticated;
create temp table fs as select public.financial_summary(current_date - 5, current_date + 1) as s;
-- net realized = 7650 - ads (10*250=2500) - overhead (1000 + 3*300 = 1900) = 3250 ; Meta top-up is informational
select tests.assert(((select s from fs) -> 'profit' ->> 'net_realized')::numeric = 3250, 'net profit: ads from API, no double count of Meta top-up');
select tests.assert(((select s from fs) -> 'ads' ->> 'total_dzd')::numeric = 2500, 'ad spend converted to DZD');
select tests.assert(((select s from fs) -> 'warnings') ? 'double_count_confirmation' = false, 'no false double-count warning');
reset role;
rollback;
\echo 'ok'
