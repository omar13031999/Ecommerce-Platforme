\o /dev/null
\echo '--- RLS: financial privacy & role boundaries'
begin;
select tests.login(null);
create temp table ids as select
  tests.create_user('owner@t', 'admin') as admin,
  tests.create_user('mgr@t', 'manager') as mgr,
  tests.create_user('a@t', 'agent', true, 50) as a,
  tests.create_user('b@t', 'agent', true, 50) as b;
grant select on ids to authenticated;

-- Product with a confidential purchase cost; one order for A, one for B
insert into public.products (id, sku, name, selling_price) values ('11111111-1111-1111-1111-111111111111', 'SKU-1', 'Montre', 4500);
update public.product_costs set purchase_cost = 1800 where product_id = '11111111-1111-1111-1111-111111111111';
insert into public.expenses (title, category_id, amount, expense_date)
  select 'Salaire Agent A', id, 45000, current_date from public.expense_categories where kind = 'salary';
do $$ declare r record; v uuid; begin
  select * into r from ids;
  update public.app_settings set value = value || '{"auto_assign_enabled": false}' where key = 'assignment';
  v := tests.new_order(); perform public._assign_to(v, r.a, 'manual', null);
  insert into public.order_items (order_id, product_name, sku, quantity, unit_price) values (v, 'Montre', 'SKU-1', 1, 4500);
  v := tests.new_order(); perform public._assign_to(v, r.b, 'manual', null);
end $$;
select tests.assert((select count(*) from public.order_item_costs where unit_cost = 1800) = 1, 'cost snapshot captured at creation');

-- ============ AGENT =============
select tests.login((select a from ids)); set role authenticated;
select tests.assert((select count(*) from public.orders) = 1, 'agent sees only own orders');
select tests.assert((select count(*) from public.order_items) = 2, 'agent sees own order lines');
select tests.assert((select count(*) from public.products) = 1, 'agent sees product names');
select tests.assert((select count(*) from public.product_costs) = 0, 'agent cannot read purchase costs');
select tests.assert((select count(*) from public.order_item_costs) = 0, 'agent cannot read cost snapshots');
select tests.assert((select count(*) from public.order_financials) = 0, 'agent cannot read order financials');
select tests.assert((select count(*) from public.cod_settlements) = 0, 'agent cannot read settlements');
select tests.assert((select count(*) from public.expenses) = 0, 'agent cannot read expenses / salaries');
select tests.assert((select count(*) from public.expense_categories) = 0, 'agent cannot read expense categories');
select tests.assert((select count(*) from public.ad_insights_daily) = 0, 'agent cannot read ad spend');
select tests.assert((select count(*) from public.ad_spend_daily) = 0, 'agent cannot read ad spend view');
select tests.assert((select count(*) from public.order_profit) = 0, 'agent gets no profit rows');
select tests.assert((select count(*) from public.delivery_shipments) = 0, 'agent cannot read raw delivery API responses');
select tests.assert((select count(*) from public.delivery_rates) = 0, 'agent cannot read delivery tariffs');
select tests.assert((select count(*) from public.app_settings) = 0, 'agent cannot read settings');
select tests.assert((select count(*) from public.profiles) = 1, 'agent sees only own profile');
select tests.assert((select count(*) from public.audit_logs) = 0, 'agent cannot read audit logs');
do $$ begin
  perform public.financial_summary(current_date - 30, current_date);
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden' then raise; end if; end $$;
do $$ begin
  perform * from public.product_financial_stats(current_date - 30, current_date);
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden' then raise; end if; end $$;
do $$ begin
  perform * from public.agent_performance(current_date - 30, current_date);
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden' then raise; end if; end $$;
-- Secrets table is unreachable
do $$ begin
  perform * from public.integration_secrets;
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
-- Internal engine functions are not callable
do $$ begin
  perform public.assign_order(gen_random_uuid());
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.get_setting('finance');
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
-- Privilege escalation attempts
do $$ begin
  update public.profiles set role = 'admin' where id = auth.uid();
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update public.profiles set permissions = '{finance.view}' where id = auth.uid();
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.update_staff_member(auth.uid(), '{"permissions": ["finance.view"]}');
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden' then raise; end if; end $$;
-- Direct status manipulation bypassing the workflow is refused
do $$ begin
  update public.orders set confirmation_status = 'confirmed';
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
-- Agents cannot touch other agents' orders through RPCs
do $$ begin
  perform public.set_confirmation_status((select id from public.orders o, ids where o.assigned_to = ids.b), 'confirmed');
  raise exception 'should have failed';
exception when others then if sqlerrm not in ('not_assigned', 'order_not_found') then raise; end if; end $$;
-- Agent can add a note on own order and update the address
insert into public.order_notes (order_id, author_id, body) select id, auth.uid(), 'Client rappelle demain' from public.orders;
select public.update_order_customer((select id from public.orders), '{"address": "Cité 200 logements"}');
reset role; select tests.login(null);
select tests.assert((select count(*) from public.order_events where event_type = 'note_added') = 1, 'note logged in history');
select tests.assert(exists (select 1 from public.order_events where field = 'address' and new_value = 'Cité 200 logements'), 'address change logged');

-- Agent cannot add notes on someone else's order
create temp table foreign_order as select o.id from public.orders o, ids where o.assigned_to = ids.b;
grant select on foreign_order to authenticated;
select tests.login((select a from ids)); set role authenticated;
do $$ begin
  insert into public.order_notes (order_id, author_id, body) values ((select id from foreign_order), auth.uid(), 'intrusion');
  raise exception 'should have failed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.update_order_customer((select id from foreign_order), '{"address": "x"}');
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'not_assigned' then raise; end if; end $$;
reset role; select tests.login(null);

-- ============ MANAGER =============
select tests.login((select mgr from ids)); set role authenticated;
select tests.assert((select count(*) from public.orders) = 2, 'manager sees all orders');
select tests.assert((select count(*) from public.product_costs) = 0, 'manager cannot read purchase costs by default');
select tests.assert((select count(*) from public.expenses) = 0, 'manager cannot read expenses by default');
select tests.assert((select count(*) from public.order_profit) = 0, 'manager gets no profit rows by default');
select tests.assert((select count(*) from public.app_settings where scope = 'financial') = 0, 'manager cannot read financial settings');
select tests.assert((select count(*) from public.app_settings where key = 'assignment') = 1, 'manager reads assignment settings');
select tests.assert((select count(*) from public.profiles) = 4, 'manager sees team');
select tests.assert(jsonb_typeof(public.dashboard_operational(current_date - 1, current_date)) = 'object', 'manager operational dashboard');
-- Manager may manage agents' capacity but cannot grant financial access
select public.update_staff_member((select a from ids), '{"max_active_orders": 40}');
do $$ begin
  perform public.update_staff_member((select a from ids), '{"permissions": ["finance.view"]}');
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden_permissions' then raise; end if; end $$;
do $$ begin
  perform public.update_staff_member((select a from ids), '{"role": "manager"}');
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden_role' then raise; end if; end $$;
do $$ begin
  perform public.update_staff_member((select admin from ids), '{"is_active": false}');
  raise exception 'should have failed';
exception when others then if sqlerrm <> 'forbidden_target' then raise; end if; end $$;
reset role; select tests.login(null);

-- ============ OWNER grants finance.view to the manager =============
select tests.login((select admin from ids)); set role authenticated;
select public.update_staff_member((select mgr from ids), '{"permissions": ["finance.view"]}');
select tests.assert((select count(*) from public.product_costs) = 1, 'owner reads costs');
select tests.assert((select count(*) from public.expenses) = 1, 'owner reads expenses');
do $$ begin
  perform public.update_staff_member(auth.uid(), '{"is_active": false}');
  raise exception 'should have failed';
exception when others then if sqlerrm not in ('last_admin', 'cannot_modify_self') then raise; end if; end $$;
reset role; select tests.login(null);

select tests.login((select mgr from ids)); set role authenticated;
select tests.assert((select count(*) from public.product_costs) = 1, 'granted manager reads costs');
select tests.assert((select count(*) from public.order_profit) = 2, 'granted manager reads profit');
do $$ begin
  update public.product_costs set purchase_cost = 1 ;
  if found then raise exception 'finance.view must not allow writes'; end if;
end $$;
reset role; select tests.login(null);
select tests.assert((select purchase_cost from public.product_costs) = 1800, 'cost unchanged by read-only finance user');
select tests.assert(exists (select 1 from public.audit_logs where action = 'staff_update'), 'permission change audited');

-- Deactivated users lose everything immediately
update public.profiles set is_active = false where id = (select mgr from ids);
select tests.login((select mgr from ids)); set role authenticated;
select tests.assert((select count(*) from public.orders) = 0, 'inactive user sees nothing');
reset role;
rollback;
\echo 'ok'
