-- =============================================================================
-- 0001 — Foundation: extensions, enums, profiles, permissions, settings, audit
-- =============================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'manager', 'agent');

create type public.confirmation_status as enum (
  'new',
  'no_answer_1', 'no_answer_2', 'no_answer_3', 'no_answer_4', 'no_answer_5',
  'no_answer_6', 'no_answer_7', 'no_answer_8', 'no_answer_9',
  'unreachable',
  'cancelled',
  'duplicate',
  'confirmed'
);

create type public.delivery_status as enum (
  'not_submitted',
  'pending_submission',
  'submission_failed',
  'submitted',
  'processing',
  'ready_for_pickup',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'distributed',
  'delivered',
  'failed_delivery',
  'returned',
  'cancelled'
);

create type public.app_locale as enum ('fr', 'ar');

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  full_name            text not null default '',
  email                text,
  phone                text,
  role                 public.app_role not null default 'agent',
  -- Extra permissions granted on top of the role defaults (see role_default_permissions)
  permissions          text[] not null default '{}',
  is_active            boolean not null default false,
  locale               public.app_locale not null default 'fr',
  -- Capacity-based assignment
  max_active_orders    integer not null default 30 check (max_active_orders >= 0 and max_active_orders <= 10000),
  accepts_assignments  boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on column public.profiles.permissions is
  'Additional permissions (e.g. finance.view) granted by the owner on top of role defaults.';

-- Permissions catalogue -------------------------------------------------------
-- Keep in sync with src/lib/auth/permissions.ts
create or replace function public.all_permissions()
returns text[] language sql immutable as $$
  select array[
    'orders.view_all', 'orders.manage', 'orders.assign', 'orders.create', 'orders.export',
    'team.view', 'team.manage',
    'delivery.view', 'delivery.manage',
    'products.manage',
    'reports.operational',
    'finance.view', 'finance.manage', 'expenses.manage',
    'ads.view', 'ads.manage',
    'integrations.manage', 'settings.manage'
  ]::text[]
$$;

-- Financial / owner-only permissions that only an admin may grant.
create or replace function public.sensitive_permissions()
returns text[] language sql immutable as $$
  select array[
    'finance.view', 'finance.manage', 'expenses.manage',
    'ads.view', 'ads.manage', 'integrations.manage', 'settings.manage'
  ]::text[]
$$;

create or replace function public.role_default_permissions(p_role public.app_role)
returns text[] language sql immutable as $$
  select case p_role
    when 'admin' then public.all_permissions()
    when 'manager' then array[
      'orders.view_all', 'orders.manage', 'orders.assign', 'orders.create', 'orders.export',
      'team.view', 'team.manage', 'delivery.view', 'delivery.manage', 'reports.operational'
    ]::text[]
    else '{}'::text[]
  end
$$;

-- The single source of truth for authorization inside the database.
create or replace function public.has_permission(p_perm text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid()
      and pr.is_active
      and (
        pr.role = 'admin'
        or p_perm = any (public.role_default_permissions(pr.role))
        or p_perm = any (pr.permissions)
      )
  )
$$;

create or replace function public.current_role_name()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select pr.role from public.profiles pr where pr.id = auth.uid() and pr.is_active
$$;

create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_active)
$$;

-- Actor resolution: authenticated user, or an id provided by trusted server code
-- (service role) through `set_config('app.actor_id', ...)`.
create or replace function public.current_actor()
returns uuid
language plpgsql stable set search_path = ''
as $$
declare
  v text;
begin
  if auth.uid() is not null then
    return auth.uid();
  end if;
  v := nullif(current_setting('app.actor_id', true), '');
  if v is null then
    return null;
  end if;
  return v::uuid;
exception when others then
  return null;
end
$$;

create or replace function public.current_actor_label()
returns text
language sql stable set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.actor_label', true), ''),
                  case when auth.uid() is null then 'system' else 'user' end)
$$;

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- New auth user -> profile. Role/activation come ONLY from app_metadata, which
-- users cannot modify themselves. Users without an explicit role are inactive
-- agents (public sign-up must be disabled in Supabase Auth settings anyway).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role := 'agent';
  v_active boolean := false;
  v_locale public.app_locale := 'fr';
begin
  if new.raw_app_meta_data ? 'role' then
    begin
      v_role := (new.raw_app_meta_data ->> 'role')::public.app_role;
      v_active := coalesce((new.raw_app_meta_data ->> 'active')::boolean, true);
    exception when others then
      v_role := 'agent';
      v_active := false;
    end;
  end if;
  if (new.raw_user_meta_data ->> 'locale') in ('fr', 'ar') then
    v_locale := (new.raw_user_meta_data ->> 'locale')::public.app_locale;
  end if;

  insert into public.profiles (id, full_name, email, role, is_active, locale)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    new.email,
    v_role,
    v_active,
    v_locale
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Application settings (key/value). Scope decides who may read them.
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  scope       text not null check (scope in ('operational', 'financial', 'system')),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);

insert into public.app_settings (key, scope, value) values
  ('assignment', 'operational', jsonb_build_object(
      'auto_assign_enabled', true,
      'workload_statuses', jsonb_build_array(
        'new', 'no_answer_1', 'no_answer_2', 'no_answer_3', 'no_answer_4', 'no_answer_5',
        'no_answer_6', 'no_answer_7', 'no_answer_8', 'no_answer_9', 'unreachable'),
      'redistribution_enabled', true,
      'redistribution_threshold', 3,
      'max_redistributions', 3,
      'final_no_answer_status', 'no_answer_9',
      'final_action', 'review'
  )),
  ('delivery', 'operational', jsonb_build_object(
      'auto_submit_enabled', false,
      'default_provider_id', null
  )),
  ('operational_costs', 'financial', jsonb_build_object(
      'confirmation_cost', 0,
      'packaging_cost', 0,
      'storage_cost', 0,
      'other_cost', 0
  )),
  ('finance', 'financial', jsonb_build_object(
      'include_customer_delivery_fee_in_revenue', true,
      'product_recovered_on_return', true
  )),
  ('ads_allocation', 'financial', jsonb_build_object(
      'use_attribution', true,
      'fallback_method', 'distributed'
  ));

create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.tg_set_updated_at();

create or replace function public.get_setting(p_key text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select value from public.app_settings where key = p_key
$$;

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.profiles (id) on delete set null,
  actor_label  text,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create or replace function public.log_audit(
  p_action text, p_entity_type text, p_entity_id text, p_before jsonb default null, p_after jsonb default null
) returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_logs (actor_id, actor_label, action, entity_type, entity_id, before, after)
  values (public.current_actor(), public.current_actor_label(), p_action, p_entity_type, p_entity_id, p_before, p_after)
$$;

-- Audit trigger for simple configuration tables
create or replace function public.tg_audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_audit('insert', tg_table_name, (to_jsonb(new) ->> 'id'), null, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(new) - 'updated_at' is distinct from to_jsonb(old) - 'updated_at' then
      perform public.log_audit('update', tg_table_name,
        coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'key', to_jsonb(new) ->> 'product_id'),
        to_jsonb(old), to_jsonb(new));
    end if;
    return new;
  else
    perform public.log_audit('delete', tg_table_name,
      coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'key'), to_jsonb(old), null);
    return old;
  end if;
end
$$;

create trigger app_settings_audit after insert or update or delete on public.app_settings
  for each row execute function public.tg_audit_row();

-- Profiles: audit role/permission/activation/capacity changes
create or replace function public.tg_audit_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (old.role, old.permissions, old.is_active, old.max_active_orders, old.accepts_assignments)
     is distinct from
     (new.role, new.permissions, new.is_active, new.max_active_orders, new.accepts_assignments) then
    perform public.log_audit('staff_update', 'profiles', new.id::text,
      jsonb_build_object('role', old.role, 'permissions', old.permissions, 'is_active', old.is_active,
                         'max_active_orders', old.max_active_orders, 'accepts_assignments', old.accepts_assignments),
      jsonb_build_object('role', new.role, 'permissions', new.permissions, 'is_active', new.is_active,
                         'max_active_orders', new.max_active_orders, 'accepts_assignments', new.accepts_assignments));
  end if;
  return new;
end
$$;

create trigger profiles_audit after update on public.profiles
  for each row execute function public.tg_audit_profile();

-- ---------------------------------------------------------------------------
-- Notifications (fan-out per user)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  type        text not null,
  params      jsonb not null default '{}',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, read_at, created_at desc);

-- Notify every active user holding a permission (admins hold all).
create or replace function public.notify_permission(p_perm text, p_type text, p_params jsonb, p_link text default null)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (user_id, type, params, link)
  select pr.id, p_type, coalesce(p_params, '{}'::jsonb), p_link
  from public.profiles pr
  where pr.is_active
    and (pr.role = 'admin'
         or p_perm = any (public.role_default_permissions(pr.role))
         or p_perm = any (pr.permissions))
$$;

-- Same, but skip users who already have an unread notification of this type
-- created within p_window (avoids flooding during bulk imports).
create or replace function public.notify_permission_throttled(
  p_perm text, p_type text, p_params jsonb, p_link text, p_window interval
) returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (user_id, type, params, link)
  select pr.id, p_type, coalesce(p_params, '{}'::jsonb), p_link
  from public.profiles pr
  where pr.is_active
    and (pr.role = 'admin'
         or p_perm = any (public.role_default_permissions(pr.role))
         or p_perm = any (pr.permissions))
    and not exists (select 1 from public.notifications n
                    where n.user_id = pr.id and n.type = p_type and n.read_at is null
                      and n.created_at > now() - p_window)
$$;

-- ---------------------------------------------------------------------------
-- Background job leases (prevent overlapping cron runs across instances)
-- ---------------------------------------------------------------------------
create table public.job_leases (
  name        text primary key,
  holder      text,
  expires_at  timestamptz not null default now()
);

create or replace function public.acquire_job_lease(p_name text, p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_ok boolean;
begin
  insert into public.job_leases (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where public.job_leases.expires_at < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end
$$;

create or replace function public.release_job_lease(p_name text, p_holder text)
returns void
language sql security definer set search_path = ''
as $$
  update public.job_leases set expires_at = now() where name = p_name and holder = p_holder
$$;

-- ---------------------------------------------------------------------------
-- Sync / job run log
-- ---------------------------------------------------------------------------
create table public.sync_runs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'google_sheets', 'delivery_poll', 'delivery_submit', 'meta_ads',
                 'recurring_expenses', 'assignment', 'redistribution', 'settlement_import')),
  target_id    uuid,
  trigger      text not null default 'schedule' check (trigger in ('schedule', 'manual', 'webhook', 'retry')),
  status       text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}',
  error        text,
  triggered_by uuid references public.profiles (id) on delete set null
);
create index sync_runs_kind_idx on public.sync_runs (kind, target_id, started_at desc);
