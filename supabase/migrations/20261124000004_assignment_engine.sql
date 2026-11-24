-- =============================================================================
-- 0004 — Capacity-based assignment, redistribution and confirmation workflow
--
-- Concurrency model: every decision that reads agent workloads and then assigns
-- an order runs under a single transaction-scoped advisory lock
-- (lock_assignment_engine). Two orders arriving simultaneously can therefore
-- never observe the same stale workload, and an order row is always locked
-- (FOR UPDATE) after the engine lock — a consistent lock order that avoids
-- deadlocks.
-- =============================================================================

create or replace function public.lock_assignment_engine()
returns void language sql as $$
  select pg_advisory_xact_lock(724300118)
$$;

create or replace function public.na_level(p_status public.confirmation_status)
returns integer language sql immutable as $$
  select case when p_status::text like 'no_answer_%' then substring(p_status::text from '\d+$')::integer else 0 end
$$;

create or replace function public.assignment_settings()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((select value from public.app_settings where key = 'assignment'), '{}'::jsonb)
$$;

create or replace function public.workload_statuses()
returns public.confirmation_status[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select array_agg(s::public.confirmation_status)
       from jsonb_array_elements_text(public.assignment_settings() -> 'workload_statuses') s),
    array['new']::public.confirmation_status[])
$$;

create or replace function public.agent_workload(p_agent uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer
  from public.orders o
  where o.assigned_to = p_agent
    and o.confirmation_status = any (public.workload_statuses())
    and o.delivery_status in ('not_submitted', 'submission_failed')
$$;

-- Pick the eligible agent with the lowest active workload.
-- Ordering: never-handled-this-order first, then lowest workload, then the
-- agent who waited longest since their last assignment (fair tie-break).
create or replace function public.pick_agent(p_order_id uuid, p_exclude uuid[] default '{}')
returns uuid
language sql stable security definer set search_path = ''
as $$
  with ws as (select public.workload_statuses() as statuses),
  candidates as (
    select
      p.id,
      p.max_active_orders,
      (select count(*) from public.orders o, ws
        where o.assigned_to = p.id
          and o.confirmation_status = any (ws.statuses)
          and o.delivery_status in ('not_submitted', 'submission_failed')) as workload,
      exists (select 1 from public.order_assignments a where a.order_id = p_order_id and a.agent_id = p.id) as handled_before,
      (select max(a.started_at) from public.order_assignments a where a.agent_id = p.id) as last_assigned_at
    from public.profiles p
    where p.role = 'agent'
      and p.is_active
      and p.accepts_assignments
      and not (p.id = any (coalesce(p_exclude, '{}'::uuid[])))
  )
  select c.id from candidates c
  where c.workload < c.max_active_orders
  order by c.handled_before asc, c.workload asc, c.last_assigned_at asc nulls first, c.id
  limit 1
$$;

-- Low-level: move an (already locked) order to an agent and record history.
create or replace function public._assign_to(p_order_id uuid, p_agent uuid, p_reason text, p_actor uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.confirmation_status;
begin
  select confirmation_status into v_status from public.orders where id = p_order_id;

  update public.order_assignments
     set ended_at = now(), status_at_end = v_status, end_reason = p_reason
   where order_id = p_order_id and ended_at is null;

  insert into public.order_assignments (order_id, agent_id, assigned_by, reason, status_at_start)
  values (p_order_id, p_agent, p_actor, p_reason, v_status);

  perform set_config('app.event_reason', p_reason, true);
  update public.orders
     set assigned_to = p_agent, assigned_at = now(), awaiting_assignment = false
   where id = p_order_id;
  perform set_config('app.event_reason', '', true);
end
$$;

create or replace function public._unassign(p_order_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.confirmation_status;
  v_ref bigint;
begin
  select confirmation_status, reference into v_status, v_ref
  from public.orders where id = p_order_id;

  update public.order_assignments
     set ended_at = now(), status_at_end = v_status, end_reason = p_reason
   where order_id = p_order_id and ended_at is null;

  perform set_config('app.event_reason', p_reason, true);
  update public.orders set assigned_to = null, assigned_at = null, awaiting_assignment = true
   where id = p_order_id;
  perform set_config('app.event_reason', '', true);

  insert into public.order_events (order_id, actor_id, actor_label, event_type, note, metadata)
  values (p_order_id, public.current_actor(), public.current_actor_label(), 'assignment_waiting', p_reason,
          jsonb_build_object('reason', p_reason));

  perform public.notify_permission_throttled('orders.assign', 'order_awaiting_capacity',
    jsonb_build_object('reference', v_ref, 'reason', p_reason), '/orders?queue=waiting', interval '1 hour');
end
$$;

create or replace function public._is_assignable(o public.orders)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select o.confirmation_status = any (public.workload_statuses())
     and o.delivery_status in ('not_submitted', 'submission_failed')
$$;

-- Assign (or re-assign) one order using the capacity algorithm.
--   p_keep_if_none: when no other agent is available, keep the current agent if
--   they are still active (used for redistribution); otherwise the order goes
--   back to the waiting queue and managers are notified — never silently left
--   with an inactive agent.
create or replace function public.assign_order(
  p_order_id uuid,
  p_reason text default 'auto',
  p_exclude uuid[] default '{}',
  p_keep_if_none boolean default false
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  v_agent uuid;
  v_current_ok boolean;
begin
  perform public.lock_assignment_engine();
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    return null;
  end if;
  if not public._is_assignable(o) then
    return o.assigned_to;
  end if;

  v_agent := public.pick_agent(p_order_id, p_exclude);

  if v_agent is null then
    v_current_ok := o.assigned_to is not null and exists (
      select 1 from public.profiles p where p.id = o.assigned_to and p.is_active and p.role = 'agent');
    if p_keep_if_none and v_current_ok then
      insert into public.order_events (order_id, actor_id, actor_label, event_type, note, metadata)
      values (o.id, public.current_actor(), public.current_actor_label(), 'assignment_skipped',
              'no_available_agent', jsonb_build_object('reason', p_reason));
      return o.assigned_to;
    end if;
    perform public._unassign(o.id, case when p_reason = 'auto' then 'no_capacity' else p_reason end);
    return null;
  end if;

  if v_agent is distinct from o.assigned_to then
    perform public._assign_to(o.id, v_agent, p_reason, public.current_actor());
  end if;
  return v_agent;
end
$$;

-- Drain the waiting queue (FIFO) while agents have spare capacity.
create or replace function public.assign_waiting_orders(p_limit integer default 100)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_agent uuid;
  v_count integer := 0;
begin
  if not coalesce((public.assignment_settings() ->> 'auto_assign_enabled')::boolean, true) then
    return 0;
  end if;
  perform public.lock_assignment_engine();
  for v_id in
    select o.id from public.orders o
    where o.awaiting_assignment
      and o.assigned_to is null
      and o.confirmation_status = any (public.workload_statuses())
      and o.delivery_status in ('not_submitted', 'submission_failed')
    order by o.ordered_at, o.created_at
    limit p_limit
    for update skip locked
  loop
    v_agent := public.pick_agent(v_id, '{}');
    exit when v_agent is null;
    perform public._assign_to(v_id, v_agent, 'auto', public.current_actor());
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- Auto-assign every newly created order.
create or replace function public.tg_order_auto_assign()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.assigned_to is null
     and coalesce((public.assignment_settings() ->> 'auto_assign_enabled')::boolean, true) then
    perform public.assign_order(new.id, 'auto', '{}', false);
  end if;
  return null;
end
$$;

-- "zz" so it runs after the history trigger (creation event first).
create trigger orders_zz_auto_assign after insert on public.orders
  for each row execute function public.tg_order_auto_assign();

-- ---------------------------------------------------------------------------
-- Redistribution
-- ---------------------------------------------------------------------------
create or replace function public.redistribute_order(p_order_id uuid, p_reason text default 'no_answer_threshold')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  v_new uuid;
  v_notes jsonb;
begin
  perform public.lock_assignment_engine();
  select * into o from public.orders where id = p_order_id for update;
  if not found or not public._is_assignable(o) then
    return null;
  end if;

  v_new := public.assign_order(o.id, 'redistribution',
             case when o.assigned_to is null then '{}'::uuid[] else array[o.assigned_to] end,
             true);

  if v_new is not null and v_new is distinct from o.assigned_to then
    select coalesce(jsonb_agg(x order by x ->> 'at'), '[]'::jsonb) into v_notes
    from (
      select jsonb_build_object('at', n.created_at, 'author_id', n.author_id, 'body', n.body, 'kind', 'note') as x
      from public.order_notes n where n.order_id = o.id
      union all
      select jsonb_build_object('at', e.created_at, 'author_id', e.actor_id, 'body', e.note,
                                'kind', 'status', 'status', e.new_value)
      from public.order_events e
      where e.order_id = o.id and e.event_type = 'status_change' and e.note is not null
    ) s;

    insert into public.order_redistributions (order_id, from_agent_id, to_agent_id, status, contact_attempts, reason, notes_snapshot)
    values (o.id, o.assigned_to, v_new, o.confirmation_status, o.contact_attempts, p_reason, v_notes);

    update public.orders
       set redistribution_count = redistribution_count + 1,
           last_redistributed_status = o.confirmation_status
     where id = o.id;
  elsif v_new is not null then
    -- No other agent: remember we tried at this level to avoid re-trying in a loop.
    update public.orders set last_redistributed_status = o.confirmation_status where id = o.id;
  end if;
  return v_new;
end
$$;

-- Catch-up sweep for orders that reached the threshold while nobody was available.
create or replace function public.run_redistribution_sweep(p_limit integer default 200)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := public.assignment_settings();
  v_threshold integer := coalesce((s ->> 'redistribution_threshold')::integer, 3);
  v_max integer := coalesce((s ->> 'max_redistributions')::integer, 3);
  v_final integer := public.na_level(coalesce(s ->> 'final_no_answer_status', 'no_answer_9')::public.confirmation_status);
  v_id uuid;
  v_count integer := 0;
  v_before uuid;
  v_after uuid;
begin
  if not coalesce((s ->> 'redistribution_enabled')::boolean, true) then
    return 0;
  end if;
  for v_id, v_before in
    select o.id, o.assigned_to from public.orders o
    where public.na_level(o.confirmation_status) >= v_threshold
      and public.na_level(o.confirmation_status) < v_final
      and o.redistribution_count < v_max
      and o.last_redistributed_status is distinct from o.confirmation_status
      and o.delivery_status in ('not_submitted', 'submission_failed')
    order by o.updated_at
    limit p_limit
  loop
    v_after := public.redistribute_order(v_id, 'no_answer_threshold');
    if v_after is distinct from v_before then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- Move an agent's active orders to others (deactivation / stop assignments).
create or replace function public.release_agent_orders(p_agent uuid, p_reason text default 'agent_unavailable')
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  perform public.lock_assignment_engine();
  for v_id in
    select o.id from public.orders o
    where o.assigned_to = p_agent
      and o.confirmation_status = any (public.workload_statuses())
      and o.delivery_status in ('not_submitted', 'submission_failed')
    order by o.ordered_at
  loop
    perform public.assign_order(v_id, p_reason, array[p_agent], false);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- When an agent's capacity is lowered below their workload, move the excess
-- (most recently assigned untouched "new" orders first).
create or replace function public.rebalance_agent(p_agent uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_cap integer;
  v_excess integer;
  v_id uuid;
  v_moved integer := 0;
  v_result uuid;
begin
  perform public.lock_assignment_engine();
  select max_active_orders into v_cap from public.profiles where id = p_agent;
  v_excess := public.agent_workload(p_agent) - coalesce(v_cap, 0);
  if v_excess <= 0 then
    return 0;
  end if;
  for v_id in
    select o.id from public.orders o
    where o.assigned_to = p_agent
      and o.confirmation_status = any (public.workload_statuses())
      and o.delivery_status in ('not_submitted', 'submission_failed')
    order by (o.confirmation_status = 'new') desc, o.assigned_at desc
    limit v_excess
  loop
    v_result := public.assign_order(v_id, 'rebalance', array[p_agent], true);
    if v_result is distinct from p_agent then
      v_moved := v_moved + 1;
    end if;
  end loop;
  if v_moved < v_excess then
    perform public.notify_permission_throttled('orders.assign', 'agent_over_capacity',
      jsonb_build_object('agent_id', p_agent, 'excess', v_excess - v_moved), '/team', interval '1 hour');
  end if;
  return v_moved;
end
$$;

-- ---------------------------------------------------------------------------
-- Public RPC: confirmation status change (agents & managers)
-- ---------------------------------------------------------------------------
create or replace function public.set_confirmation_status(
  p_order_id uuid,
  p_status public.confirmation_status,
  p_note text default null,
  p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_manager boolean;
  o public.orders;
  s jsonb := public.assignment_settings();
  v_final_status text := coalesce(s ->> 'final_no_answer_status', 'no_answer_9');
  v_final_level integer := public.na_level(v_final_status::public.confirmation_status);
  v_threshold integer := coalesce((s ->> 'redistribution_threshold')::integer, 3);
  v_max integer := coalesce((s ->> 'max_redistributions')::integer, 3);
  v_old_level integer;
  v_new_level integer;
  v_is_final boolean;
  v_redistributed uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 4000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  v_manager := public.has_permission('orders.manage');

  perform public.lock_assignment_engine();
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if not v_manager and o.assigned_to is distinct from v_uid then
    raise exception 'not_assigned' using errcode = '42501';
  end if;
  if p_expected_version is not null and o.version <> p_expected_version then
    raise exception 'stale_version' using errcode = '40001';
  end if;
  if o.delivery_status not in ('not_submitted', 'submission_failed') then
    raise exception 'order_in_delivery' using errcode = '22023';
  end if;

  v_old_level := public.na_level(o.confirmation_status);
  v_new_level := public.na_level(p_status);

  if not v_manager then
    if p_status = 'new' and o.confirmation_status <> 'new' then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    if v_new_level > 0 and v_new_level <= v_old_level then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
  end if;

  if p_status = o.confirmation_status then
    if v_note is not null then
      insert into public.order_notes (order_id, author_id, body) values (o.id, v_uid, v_note);
    end if;
    return jsonb_build_object('order_id', o.id, 'status', o.confirmation_status, 'version', o.version, 'changed', false);
  end if;

  v_is_final := (v_new_level > 0 and v_new_level >= v_final_level);

  perform set_config('app.event_note', coalesce(v_note, ''), true);
  update public.orders set
    confirmation_status = p_status,
    contact_attempts = contact_attempts + case when v_new_level > 0 or p_status = 'unreachable' then 1 else 0 end,
    confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end,
    cancelled_at = case when p_status in ('cancelled', 'duplicate') then now() else cancelled_at end,
    needs_review = case when v_is_final and coalesce(s ->> 'final_action', 'review') = 'review' then true else needs_review end,
    review_reason = case when v_is_final then 'final_no_answer' else review_reason end
  where id = o.id
  returning * into o;
  perform set_config('app.event_note', '', true);

  if v_is_final then
    if coalesce(s ->> 'final_action', 'review') = 'cancel' then
      perform set_config('app.event_reason', 'final_no_answer_auto_cancel', true);
      update public.orders set confirmation_status = 'cancelled', cancelled_at = now() where id = o.id returning * into o;
      perform set_config('app.event_reason', '', true);
    else
      perform public.notify_permission('orders.manage', 'order_needs_review',
        jsonb_build_object('reference', o.reference, 'status', p_status), '/orders/' || o.id);
    end if;
  elsif coalesce((s ->> 'redistribution_enabled')::boolean, true)
        and v_new_level >= v_threshold
        and o.redistribution_count < v_max
        and o.last_redistributed_status is distinct from p_status then
    v_redistributed := public.redistribute_order(o.id, 'no_answer_threshold');
  end if;

  -- Capacity may have been freed: pull a few waiting orders.
  if not (p_status = any (public.workload_statuses())) then
    perform public.assign_waiting_orders(5);
  end if;

  return jsonb_build_object(
    'order_id', o.id,
    'status', p_status,
    'version', (select version from public.orders where id = o.id),
    'changed', true,
    'redistributed_to', case when v_redistributed is distinct from v_uid then v_redistributed end);
end
$$;

-- Manual (bulk) assignment by managers.
create or replace function public.manual_assign_orders(
  p_order_ids uuid[], p_agent_id uuid, p_force boolean default false, p_note text default null
) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_agent public.profiles;
  v_id uuid;
  v_count integer := 0;
  v_workload integer;
begin
  if not public.has_permission('orders.assign') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_agent from public.profiles where id = p_agent_id;
  if not found or not v_agent.is_active or v_agent.role not in ('agent', 'manager') then
    raise exception 'agent_unavailable' using errcode = '22023';
  end if;

  perform public.lock_assignment_engine();
  v_workload := public.agent_workload(p_agent_id);
  if not p_force and v_workload + coalesce(array_length(p_order_ids, 1), 0) > v_agent.max_active_orders then
    raise exception 'capacity_exceeded' using errcode = '22023';
  end if;

  perform set_config('app.event_note', coalesce(p_note, ''), true);
  for v_id in
    select o.id from public.orders o
    where o.id = any (p_order_ids)
      and o.delivery_status in ('not_submitted', 'submission_failed')
      and o.assigned_to is distinct from p_agent_id
    for update
  loop
    perform public._assign_to(v_id, p_agent_id, 'manual', auth.uid());
    v_count := v_count + 1;
  end loop;
  perform set_config('app.event_note', '', true);
  return v_count;
end
$$;

create or replace function public.auto_assign_orders(p_order_ids uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
  v_res uuid;
begin
  if not public.has_permission('orders.assign') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  foreach v_id in array p_order_ids loop
    v_res := public.assign_order(v_id, 'auto', '{}', true);
    if v_res is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

create or replace function public.unassign_orders(p_order_ids uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  if not public.has_permission('orders.assign') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.lock_assignment_engine();
  for v_id in select id from public.orders where id = any (p_order_ids) and assigned_to is not null for update loop
    perform public._unassign(v_id, 'manual_unassign');
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create or replace function public.resolve_review(p_order_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_permission('orders.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform set_config('app.event_note', coalesce(p_note, ''), true);
  update public.orders set needs_review = false, review_reason = null where id = p_order_id;
  perform set_config('app.event_note', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Staff management (role/permission/capacity), enforced in the database.
-- ---------------------------------------------------------------------------
create or replace function public.update_staff_member(p_user_id uuid, p_patch jsonb)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller_role public.app_role := public.current_role_name();
  t public.profiles;
  n public.profiles;
  v_perms text[];
begin
  if not public.has_permission('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  if v_caller_role <> 'admin' then
    if t.role <> 'agent' then
      raise exception 'forbidden_target' using errcode = '42501';
    end if;
    if p_patch ? 'role' and p_patch ->> 'role' <> 'agent' then
      raise exception 'forbidden_role' using errcode = '42501';
    end if;
    if p_patch ? 'permissions' then
      raise exception 'forbidden_permissions' using errcode = '42501';
    end if;
  end if;

  if p_patch ? 'permissions' then
    select coalesce(array_agg(distinct x), '{}') into v_perms
    from jsonb_array_elements_text(p_patch -> 'permissions') x;
    if exists (select 1 from unnest(v_perms) x where not (x = any (public.all_permissions()))) then
      raise exception 'unknown_permission' using errcode = '22023';
    end if;
  end if;

  n := t;
  if p_patch ? 'full_name' then n.full_name := btrim(p_patch ->> 'full_name'); end if;
  if p_patch ? 'phone' then n.phone := nullif(btrim(p_patch ->> 'phone'), ''); end if;
  if p_patch ? 'role' then n.role := (p_patch ->> 'role')::public.app_role; end if;
  if p_patch ? 'permissions' then n.permissions := v_perms; end if;
  if p_patch ? 'is_active' then n.is_active := (p_patch ->> 'is_active')::boolean; end if;
  if p_patch ? 'max_active_orders' then n.max_active_orders := (p_patch ->> 'max_active_orders')::integer; end if;
  if p_patch ? 'accepts_assignments' then n.accepts_assignments := (p_patch ->> 'accepts_assignments')::boolean; end if;
  if p_patch ? 'locale' then n.locale := (p_patch ->> 'locale')::public.app_locale; end if;

  -- Never lock the business out: keep at least one active admin.
  if t.role = 'admin' and t.is_active and (n.role <> 'admin' or not n.is_active)
     and (select count(*) from public.profiles where role = 'admin' and is_active and id <> t.id) = 0 then
    raise exception 'last_admin' using errcode = '22023';
  end if;
  if p_user_id = auth.uid() and (n.role <> t.role or not n.is_active) then
    raise exception 'cannot_modify_self' using errcode = '22023';
  end if;

  update public.profiles set
    full_name = n.full_name, phone = n.phone, role = n.role, permissions = n.permissions,
    is_active = n.is_active, max_active_orders = n.max_active_orders,
    accepts_assignments = n.accepts_assignments, locale = n.locale
  where id = p_user_id
  returning * into n;

  if t.role = 'agent' and (not n.is_active or not n.accepts_assignments or n.role <> 'agent') then
    perform public.release_agent_orders(p_user_id, 'agent_unavailable');
  elsif n.role = 'agent' and n.max_active_orders < t.max_active_orders then
    perform public.rebalance_agent(p_user_id);
  elsif n.role = 'agent' and (n.max_active_orders > t.max_active_orders or (n.is_active and not t.is_active)
                              or (n.accepts_assignments and not t.accepts_assignments)) then
    perform public.assign_waiting_orders(100);
  end if;
  return n;
end
$$;
