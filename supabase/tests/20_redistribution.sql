\o /dev/null
\echo '--- no-answer redistribution & confirmation workflow'
begin;
select tests.login(null);
create temp table ids as select
  tests.create_user('mgr@t', 'manager') as mgr,
  tests.create_user('a@t', 'agent', true, 50) as a,
  tests.create_user('b@t', 'agent', true, 50) as b,
  tests.create_user('c@t', 'agent', true, 50) as c;
grant select on ids to authenticated;

-- Pre-load B and C so the test order deterministically goes to A first
do $$ declare r record; v uuid; begin
  select * into r from ids;
  update public.app_settings set value = value || '{"auto_assign_enabled": false}' where key = 'assignment';
  v := tests.new_order(); perform public._assign_to(v, r.b, 'manual', null);
  v := tests.new_order(); perform public._assign_to(v, r.c, 'manual', null);
  v := tests.new_order(); perform public._assign_to(v, r.c, 'manual', null);
  update public.app_settings set value = value || '{"auto_assign_enabled": true, "redistribution_threshold": 3, "max_redistributions": 3}' where key = 'assignment';
end $$;

create temp table t as select tests.new_order('Karim', '0555000000') as o;
grant select on t to authenticated;
select tests.assert((select assigned_to from public.orders where id = (select o from t)) = (select a from ids), 'order starts with A');

-- A: NA1, NA2 stay with A
select tests.login((select a from ids)); set role authenticated;
select public.set_confirmation_status((select o from t), 'no_answer_1', 'pas de réponse');
select public.set_confirmation_status((select o from t), 'no_answer_2');
reset role; select tests.login(null);
select tests.assert((select assigned_to from public.orders where id = (select o from t)) = (select a from ids), 'NA2 stays with A');

-- Agents cannot go back in no-answer level
select tests.login((select a from ids)); set role authenticated;
do $$ begin
  perform public.set_confirmation_status((select o from t), 'no_answer_1');
  raise exception 'should have failed';
exception when others then
  if sqlerrm <> 'invalid_transition' then raise; end if;
end $$;
-- Stale version is refused
do $$ begin
  perform public.set_confirmation_status((select o from t), 'no_answer_3', null, 1);
  raise exception 'should have failed';
exception when others then
  if sqlerrm <> 'stale_version' then raise; end if;
end $$;
-- NA3 reaches the threshold -> redistributed
select public.set_confirmation_status((select o from t), 'no_answer_3', 'toujours rien');
reset role; select tests.login(null);
select tests.assert((select assigned_to from public.orders where id = (select o from t)) = (select b from ids), 'NA3 redistributed to B (lowest workload, never handled)');
select tests.assert((select count(*) from public.order_redistributions where order_id = (select o from t)) = 1, 'redistribution recorded');
select tests.assert((select jsonb_array_length(notes_snapshot) from public.order_redistributions where order_id = (select o from t)) = 2, 'previous notes preserved in snapshot');
select tests.assert((select contact_attempts from public.orders where id = (select o from t)) = 3, 'attempts preserved');

-- Previous agent lost access (cannot see nor edit)
select tests.login((select a from ids)); set role authenticated;
select tests.assert((select count(*) from public.orders where id = (select o from t)) = 0, 'A cannot see the order anymore');
do $$ begin
  perform public.set_confirmation_status((select o from t), 'confirmed');
  raise exception 'should have failed';
exception when others then
  if sqlerrm <> 'not_assigned' then raise; end if;
end $$;
reset role;

-- B sees it, with previous notes; NA4 -> must go to C (A already handled it)
select tests.login((select b from ids)); set role authenticated;
select tests.assert((select count(*) from public.order_events where order_id = (select o from t) and note is not null) >= 2, 'B sees previous interaction notes');
select public.set_confirmation_status((select o from t), 'no_answer_4');
reset role; select tests.login(null);
select tests.assert((select assigned_to from public.orders where id = (select o from t)) = (select c from ids), 'NA4 -> C (prefers agents who never handled it)');

-- C: NA5 -> only A/B remain, both handled; goes to lowest workload among them
select tests.login((select c from ids)); set role authenticated;
select public.set_confirmation_status((select o from t), 'no_answer_5');
reset role; select tests.login(null);
select tests.assert((select redistribution_count from public.orders where id = (select o from t)) = 3, 'three redistributions');
create temp table holder as select assigned_to as h from public.orders where id = (select o from t);
grant select on holder to authenticated;

-- Max redistributions reached: NA6 stays put (no loop)
select tests.login((select h from holder)); set role authenticated;
select public.set_confirmation_status((select o from t), 'no_answer_6');
reset role; select tests.login(null);
select tests.assert((select assigned_to from public.orders where id = (select o from t)) = (select h from holder), 'no further redistribution after max');

-- NA9 -> flagged for review + managers notified
select tests.login((select h from holder)); set role authenticated;
select public.set_confirmation_status((select o from t), 'no_answer_9');
reset role; select tests.login(null);
select tests.assert((select needs_review from public.orders where id = (select o from t)), 'NA9 flagged for review');
select tests.assert(exists (select 1 from public.notifications where user_id = (select mgr from ids) and type = 'order_needs_review'), 'manager notified for review');

-- Status history complete: agent, previous, new, timestamp
select tests.assert((select count(*) from public.order_events where order_id = (select o from t) and event_type = 'status_change' and actor_id is not null and old_value is not null) = 7, 'status history recorded');

-- Manager resolves the review and cancels
select tests.login((select mgr from ids)); set role authenticated;
select public.resolve_review((select o from t), 'client injoignable définitivement');
select public.set_confirmation_status((select o from t), 'cancelled', 'annulation après revue');
reset role; select tests.login(null);
select tests.assert((select confirmation_status = 'cancelled' and not needs_review from public.orders where id = (select o from t)), 'manager can finalise');

-- Cancelled orders cannot be submitted to delivery
do $$ begin
  perform public.claim_shipment_submission((select o from t), gen_random_uuid());
  raise exception 'should have failed';
exception when others then
  if sqlerrm <> 'order_not_confirmed' then raise; end if;
end $$;
rollback;
\echo 'ok'
