\o /dev/null
\echo '--- postponed orders + due notifications, owner-only delete, confirmer permissions'
begin;
select tests.login(null);
create temp table ids as select tests.create_user('owner6@t', 'admin') as admin, tests.create_user('mgr6@t', 'manager') as mgr,
  tests.create_user('agent6@t', 'agent', true, 50) as a;
grant select on ids to authenticated;
create temp table t as select tests.new_order('Postpone Client', '0555000666') as o;
grant select on t to authenticated;
update public.orders set assigned_to = (select a from ids) where id = (select o from t);

-- The assigned confirmer postpones the order
select tests.login((select a from ids));
set role authenticated;
select public.postpone_order((select o from t), now() + interval '2 hours', 'rappeler après 18h');
reset role;
select tests.login(null);
select tests.assert((select confirmation_status = 'postponed' and postponed_until > now() and postpone_notified_at is null
                       from public.orders where id = (select o from t)), 'order postponed with a date');
select tests.assert(public.notify_due_postponed() = 0, 'nothing due yet');

-- Date reached: exactly one notification for the assigned confirmer
update public.orders set postponed_until = now() - interval '1 minute' where id = (select o from t);
select tests.assert(public.notify_due_postponed() = 1, 'due order notified');
select tests.assert(public.notify_due_postponed() = 0, 'notified only once');
select tests.assert((select count(*) = 1 from public.notifications where user_id = (select a from ids) and type = 'postponed_due'), 'confirmer got the reminder');

-- Invalid dates are refused
select tests.login((select a from ids));
set role authenticated;
do $$ begin
  perform public.postpone_order((select o from t), now() - interval '1 day');
  raise exception 'ASSERTION FAILED: past date accepted';
exception when sqlstate '22023' then null;
end $$;

-- Confirmers can add products, not delete orders
insert into public.products (sku, name, selling_price) values ('AGENT-NEW', 'Produit ajouté par agent', 1000);
do $$ begin
  perform public.delete_orders(array[(select o from t)]);
  raise exception 'ASSERTION FAILED: agent deleted an order';
exception when insufficient_privilege then null;
end $$;
reset role;

-- Managers cannot delete either; the owner can, and it is audited
select tests.login((select mgr from ids));
set role authenticated;
do $$ begin
  perform public.delete_orders(array[(select o from t)]);
  raise exception 'ASSERTION FAILED: manager deleted an order';
exception when insufficient_privilege then null;
end $$;
reset role;
select tests.login((select admin from ids));
set role authenticated;
select public.delete_orders(array[(select o from t)]);
reset role;
select tests.login(null);
select tests.assert(not exists (select 1 from public.orders where id = (select o from t)), 'owner deleted the order');
select tests.assert(exists (select 1 from public.audit_logs where entity_type = 'orders' and action = 'delete' and entity_id = (select o from t)::text), 'deletion audited');
select tests.assert(exists (select 1 from public.products where sku = 'AGENT-NEW'), 'agent product added');
rollback;
\o
\echo ok
