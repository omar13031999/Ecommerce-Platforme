-- =============================================================================
-- 0023 — Phone blacklist (liste noire) and per-user saved order filters.
-- =============================================================================

create table public.blocked_phones (
  phone_normalized text primary key,
  reason           text,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now()
);
alter table public.blocked_phones enable row level security;
create policy blocked_phones_select on public.blocked_phones for select to authenticated using (public.is_active_user());
grant select on public.blocked_phones to authenticated;

alter table public.orders add column if not exists customer_blocked boolean not null default false;

-- New orders from a blacklisted number are flagged and sent to review.
create or replace function public.tg_orders_blacklist()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text;
begin
  select coalesce(b.reason, '') into v_reason from public.blocked_phones b
   where b.phone_normalized = public.normalize_phone(new.phone);
  if found then
    new.customer_blocked := true;
    new.needs_review := true;
    new.review_reason := left('Numéro bloqué (liste noire)' || case when v_reason <> '' then ' : ' || v_reason else '' end, 500);
  end if;
  return new;
end
$$;
create trigger orders_blacklist before insert on public.orders
  for each row execute function public.tg_orders_blacklist();

create or replace function public.block_phone(p_phone text, p_reason text default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v text := public.normalize_phone(p_phone);
  n integer;
begin
  if not public.has_permission('orders.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v is null or length(v) < 9 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into public.blocked_phones (phone_normalized, reason, created_by)
  values (v, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (phone_normalized) do update set reason = excluded.reason;
  update public.orders set customer_blocked = true where phone_normalized = v and not customer_blocked;
  get diagnostics n = row_count;
  perform public.log_audit('block', 'blocked_phones', v, null, jsonb_build_object('reason', p_reason));
  return n;
end
$$;

create or replace function public.unblock_phone(p_phone text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v text := public.normalize_phone(p_phone);
begin
  if not public.has_permission('orders.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.blocked_phones where phone_normalized = v;
  update public.orders set customer_blocked = false where phone_normalized = v and customer_blocked;
  perform public.log_audit('unblock', 'blocked_phones', v, null, null);
end
$$;

-- Saved filters (each user sees only their own).
create table public.saved_filters (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  query      text not null check (length(query) <= 2000),
  created_at timestamptz not null default now()
);
create index saved_filters_user_idx on public.saved_filters (user_id, created_at);
alter table public.saved_filters enable row level security;
create policy saved_filters_own on public.saved_filters for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_active_user());
grant select, insert, delete on public.saved_filters to authenticated;

revoke execute on function public.tg_orders_blacklist() from public, anon, authenticated;
grant execute on function public.block_phone(text, text), public.unblock_phone(text) to authenticated;
