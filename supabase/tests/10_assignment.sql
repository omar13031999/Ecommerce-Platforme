\o /dev/null
\echo '--- capacity-based assignment'
begin;
select tests.login(null);
update public.app_settings set value = value || '{"auto_assign_enabled": false}' where key = 'assignment';

create temp table ids as select
  tests.create_user('admin@t', 'admin') as admin,
  tests.create_user('a@t', 'agent', true, 50) as a,
  tests.create_user('b@t', 'agent', true, 50) as b,
  tests.create_user('c@t', 'agent', true, 50) as c,
  tests.create_user('off@t', 'agent', false, 50) as off;
grant select on ids to authenticated;

-- Build workloads A=15, B=4, C=2 (auto-assign off, manual low-level assignment)
do $$
declare r record; i int; v uuid;
begin
  select * into r from ids;
  for i in 1..15 loop v := tests.new_order(); perform public._assign_to(v, r.a, 'manual', null); end loop;
  for i in 1..4 loop v := tests.new_order(); perform public._assign_to(v, r.b, 'manual', null); end loop;
  for i in 1..2 loop v := tests.new_order(); perform public._assign_to(v, r.c, 'manual', null); end loop;
end $$;

select tests.assert(public.agent_workload(a) = 15 and public.agent_workload(b) = 4 and public.agent_workload(c) = 2, 'initial workloads') from ids;

update public.app_settings set value = value || '{"auto_assign_enabled": true}' where key = 'assignment';

-- Next order goes to the lowest workload: C
do $$ declare v uuid := tests.new_order(); begin
  perform tests.assert((select assigned_to from public.orders where id = v) = (select c from ids), 'lowest workload gets the order (A=15,B=4,C=2 -> C)');
end $$;
-- Confirmed / cancelled orders do not count toward workload
do $$
declare r record; v uuid;
begin
  select * into r from ids;
  update public.orders set confirmation_status = 'confirmed' where assigned_to = r.b and id in (select id from public.orders where assigned_to = r.b limit 3);
  perform tests.assert(public.agent_workload(r.b) = 1, 'confirmed excluded from workload');
  v := tests.new_order();
  perform tests.assert((select assigned_to from public.orders where id = v) = r.b, 'B (1) now lowest');
end $$;

-- Capacity: C capped at its current workload is excluded
do $$
declare r record; v uuid;
begin
  select * into r from ids;
  update public.profiles set max_active_orders = public.agent_workload(r.c) where id = r.c;
  update public.profiles set max_active_orders = public.agent_workload(r.b) where id = r.b;
  v := tests.new_order();
  perform tests.assert((select assigned_to from public.orders where id = v) = r.a, 'only A has capacity');
  -- inactive agent never receives orders
  perform tests.assert(public.agent_workload(r.off) = 0, 'inactive agent has no orders');
  -- Everyone full -> waiting queue + manager notification
  update public.profiles set max_active_orders = public.agent_workload(r.a) where id = r.a;
  v := tests.new_order();
  perform tests.assert((select assigned_to is null and awaiting_assignment from public.orders where id = v), 'no capacity -> waiting');
  perform tests.assert(exists (select 1 from public.notifications where user_id = r.admin and type = 'order_awaiting_capacity'), 'managers notified');
  perform tests.assert(exists (select 1 from public.order_events where order_id = v and event_type = 'assignment_waiting'), 'queue event logged');
end $$;

-- Agent confirms an order -> capacity freed -> waiting order pulled automatically
select tests.login((select c from ids));
set role authenticated;
select public.set_confirmation_status((select id from public.orders where assigned_to = (select c from ids) limit 1), 'confirmed', 'OK client');
reset role;
select tests.login(null);
select tests.assert((select count(*) from public.orders where awaiting_assignment and assigned_to is null) = 0, 'waiting order assigned after capacity freed');

-- Assignment history recorded
select tests.assert((select count(*) from public.order_assignments) >= 25, 'assignment history rows');
select tests.assert((select count(*) from public.order_assignments where ended_at is null) = (select count(*) from public.orders where assigned_to is not null), 'one open assignment per assigned order');

-- Deactivating an agent releases their active orders
update public.profiles set max_active_orders = 100 where id in (select a from ids union select b from ids);
select tests.login((select admin from ids));
set role authenticated;
select public.update_staff_member((select c from ids), '{"is_active": false}');
reset role;
select tests.login(null);
select tests.assert(public.agent_workload(c) = 0, 'deactivated agent has no active workload') from ids;
select tests.assert((select count(*) from public.orders o, ids where o.assigned_to = ids.c and o.confirmation_status = 'confirmed') = 1, 'completed orders keep their agent');

-- Lowering capacity rebalances the excess
select tests.login((select admin from ids));
set role authenticated;
select public.update_staff_member((select a from ids), '{"max_active_orders": 5}');
reset role;
select tests.login(null);
select tests.assert(public.agent_workload(a) = 5, 'rebalanced to capacity') from ids;
rollback;
\echo 'ok'
