\o /dev/null
\echo '--- phone blacklist + saved filters'
begin;
select tests.login(null);
create temp table ids as select tests.create_user('owner7@t', 'admin') as admin, tests.create_user('agent7@t', 'agent', true, 50) as a,
  tests.create_user('agent7b@t', 'agent', true, 50) as b;
grant select on ids to authenticated;
create temp table t as select tests.new_order('Fraudeur', '0555 77 77 77') as o;
grant select on t to authenticated;

-- Agents cannot blacklist; managers/owner can, existing orders get flagged
select tests.login((select a from ids));
set role authenticated;
do $$ begin
  perform public.block_phone('0555777777', 'x');
  raise exception 'ASSERTION FAILED: agent blocked a number';
exception when insufficient_privilege then null;
end $$;
reset role;
select tests.login((select admin from ids));
set role authenticated;
select public.block_phone('+213 555 77 77 77', 'commandes non réceptionnées');
reset role;
select tests.login(null);
select tests.assert((select customer_blocked from public.orders where id = (select o from t)), 'existing order flagged');

-- New order from the same number: flagged and sent to review (import path too)
select public.upsert_external_order('google_sheets', null, '{"external_id": "BL-1", "customer_name": "X", "phone": "0555777777", "items": []}'::jsonb);
select tests.assert((select customer_blocked and needs_review and review_reason like 'Numéro bloqué%' from public.orders where external_id = 'BL-1'), 'new order from blocked number flagged');

-- Unblock clears the flag
select tests.login((select admin from ids));
set role authenticated;
select public.unblock_phone('0555777777');
reset role;
select tests.login(null);
select tests.assert(not exists (select 1 from public.orders where phone_normalized = '0555777777' and customer_blocked), 'unblocked');

-- Saved filters are private to each user
select tests.login((select a from ids));
set role authenticated;
insert into public.saved_filters (name, query) values ('Mes reportées', 'status=postponed');
reset role;
select tests.login((select b from ids));
set role authenticated;
select tests.assert((select count(*) from public.saved_filters) = 0, 'other agent cannot see my saved filters');
reset role;
select tests.login(null);
rollback;
\o
\echo ok
