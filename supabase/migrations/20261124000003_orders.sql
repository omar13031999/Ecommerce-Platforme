-- =============================================================================
-- 0003 — Orders, items, notes, history, assignments
-- =============================================================================

create table public.orders (
  id                         uuid primary key default gen_random_uuid(),
  reference                  bigint generated always as identity (start with 10001) unique,
  external_id                text,
  source                     text not null default 'manual' check (source in ('manual', 'google_sheets', 'api', 'import')),
  source_id                  uuid, -- e.g. sheet_sources.id
  -- Customer
  customer_name              text not null check (length(btrim(customer_name)) > 0),
  phone                      text not null,
  phone_normalized           text generated always as (public.normalize_phone(phone)) stored,
  phone2                     text,
  wilaya_code                smallint references public.wilayas (code),
  wilaya_raw                 text,
  commune                    text,
  address                    text,
  delivery_type              text not null default 'home' check (delivery_type in ('home', 'stopdesk')),
  customer_notes             text,
  -- Amounts charged to the customer (NOT confidential)
  subtotal                   numeric(12, 2) not null default 0,
  delivery_fee               numeric(12, 2) not null default 0 check (delivery_fee >= 0),
  discount                   numeric(12, 2) not null default 0 check (discount >= 0),
  total_amount               numeric(12, 2) not null default 0,
  total_override             boolean not null default false, -- true when total comes from the source as-is
  -- Confirmation workflow
  confirmation_status        public.confirmation_status not null default 'new',
  contact_attempts           integer not null default 0,
  assigned_to                uuid references public.profiles (id) on delete set null,
  assigned_at                timestamptz,
  awaiting_assignment        boolean not null default true,
  needs_review               boolean not null default false,
  review_reason              text,
  redistribution_count       integer not null default 0,
  last_redistributed_status  public.confirmation_status,
  confirmed_at               timestamptz,
  cancelled_at               timestamptz,
  -- Delivery (separate lifecycle)
  delivery_status            public.delivery_status not null default 'not_submitted',
  delivery_provider_id       uuid references public.delivery_providers (id) on delete set null,
  tracking_number            text,
  delivery_status_at         timestamptz,
  submitted_at               timestamptz,
  delivered_at               timestamptz,
  returned_at                timestamptz,
  -- Attribution
  utm_source                 text,
  utm_campaign               text,
  utm_content                text,
  meta_campaign_id           text,
  meta_adset_id              text,
  meta_ad_id                 text,
  -- Flags
  has_unmatched_items        boolean not null default false,
  possible_duplicate_of      uuid references public.orders (id) on delete set null,
  -- Timestamps / concurrency
  ordered_at                 timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  version                    integer not null default 1
);

create unique index orders_external_uidx
  on public.orders (source, coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid), external_id)
  where external_id is not null;
create index orders_assigned_idx on public.orders (assigned_to, confirmation_status);
create index orders_status_idx on public.orders (confirmation_status, ordered_at desc);
create index orders_delivery_idx on public.orders (delivery_status, delivery_status_at desc);
create index orders_ordered_at_idx on public.orders (ordered_at desc);
create index orders_phone_idx on public.orders (phone_normalized);
create index orders_tracking_idx on public.orders (tracking_number) where tracking_number is not null;
create index orders_awaiting_idx on public.orders (created_at) where awaiting_assignment;
create index orders_wilaya_idx on public.orders (wilaya_code);

create trigger orders_updated_at before update on public.orders
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Order items. Selling prices visible to staff; costs snapshotted separately.
-- ---------------------------------------------------------------------------
create table public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete cascade,
  product_id     uuid references public.products (id) on delete set null,
  product_name   text not null,          -- as received from the source
  sku            text,
  variant        text,
  quantity       integer not null check (quantity > 0),
  unit_price     numeric(12, 2) not null check (unit_price >= 0),
  line_total     numeric(12, 2) generated always as (quantity * unit_price) stored,
  match_status   text not null default 'unmatched' check (match_status in ('matched', 'manual', 'unmatched')),
  created_at     timestamptz not null default now()
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);

-- CONFIDENTIAL cost snapshot per order line. Captured at creation/match time and
-- never rewritten automatically when the product's current cost changes.
create table public.order_item_costs (
  order_item_id  uuid primary key references public.order_items (id) on delete cascade,
  unit_cost      numeric(12, 2), -- null = unknown
  cost_source    text not null default 'snapshot' check (cost_source in ('snapshot', 'manual', 'recalculated')),
  captured_at    timestamptz not null default now(),
  captured_by    uuid references public.profiles (id) on delete set null
);

-- Item trigger: match product, snapshot cost, keep order totals/flags in sync.
create or replace function public.tg_order_item_before()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.product_id is null then
    new.product_id := public.match_product(new.sku, new.product_name);
    if new.product_id is not null then
      new.match_status := 'matched';
    else
      new.match_status := 'unmatched';
    end if;
  elsif new.match_status = 'unmatched' then
    new.match_status := 'manual';
  end if;
  return new;
end
$$;

create trigger order_items_before before insert or update of product_id, sku, product_name on public.order_items
  for each row execute function public.tg_order_item_before();

create or replace function public.refresh_order_totals(p_order_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.orders o set
    subtotal = coalesce((select sum(i.line_total) from public.order_items i where i.order_id = o.id), 0),
    total_amount = case when o.total_override then o.total_amount
                        else coalesce((select sum(i.line_total) from public.order_items i where i.order_id = o.id), 0)
                             + o.delivery_fee - o.discount end,
    has_unmatched_items = exists (select 1 from public.order_items i where i.order_id = o.id and i.product_id is null)
  where o.id = p_order_id;
end
$$;

create or replace function public.tg_order_item_after()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_cost numeric(12, 2);
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if tg_op in ('INSERT', 'UPDATE') and new.product_id is not null
     and (tg_op = 'INSERT' or old.product_id is distinct from new.product_id) then
    select pc.purchase_cost into v_cost from public.product_costs pc where pc.product_id = new.product_id;
    insert into public.order_item_costs (order_item_id, unit_cost, cost_source, captured_by)
    values (new.id, v_cost, 'snapshot', public.current_actor())
    on conflict (order_item_id) do update
      set unit_cost = excluded.unit_cost, cost_source = 'snapshot', captured_at = now(), captured_by = excluded.captured_by;
  elsif tg_op = 'INSERT' then
    insert into public.order_item_costs (order_item_id, unit_cost) values (new.id, null)
    on conflict do nothing;
  end if;

  perform public.refresh_order_totals(v_order);

  -- History
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, actor_id, actor_label, event_type, new_value)
    values (new.order_id, public.current_actor(), public.current_actor_label(), 'item_added',
            new.product_name || ' x' || new.quantity || ' @ ' || new.unit_price);
  elsif tg_op = 'UPDATE' then
    if (old.product_id, old.quantity, old.unit_price, old.product_name)
       is distinct from (new.product_id, new.quantity, new.unit_price, new.product_name) then
      insert into public.order_events (order_id, actor_id, actor_label, event_type, old_value, new_value, metadata)
      values (new.order_id, public.current_actor(), public.current_actor_label(), 'item_updated',
              old.product_name || ' x' || old.quantity || ' @ ' || old.unit_price,
              new.product_name || ' x' || new.quantity || ' @ ' || new.unit_price,
              jsonb_build_object('item_id', new.id, 'old_product_id', old.product_id, 'new_product_id', new.product_id));
    end if;
  else
    insert into public.order_events (order_id, actor_id, actor_label, event_type, old_value)
    values (old.order_id, public.current_actor(), public.current_actor_label(), 'item_removed',
            old.product_name || ' x' || old.quantity || ' @ ' || old.unit_price);
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------
-- Order history (append-only)
-- ---------------------------------------------------------------------------
create table public.order_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id) on delete cascade,
  actor_id     uuid references public.profiles (id) on delete set null,
  actor_label  text,
  event_type   text not null,
  field        text,
  old_value    text,
  new_value    text,
  note         text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index order_events_order_idx on public.order_events (order_id, created_at);
create index order_events_type_idx on public.order_events (event_type, created_at desc);

create trigger order_items_after after insert or update or delete on public.order_items
  for each row execute function public.tg_order_item_after();

-- Field-level history for every operationally important order column.
create or replace function public.tg_order_history()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := public.current_actor();
  v_label text := public.current_actor_label();
  v_note text := nullif(current_setting('app.event_note', true), '');
  v_reason text := nullif(current_setting('app.event_reason', true), '');
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_field text;
  v_type text;
  v_fields text[] := array[
    'confirmation_status', 'assigned_to', 'delivery_status', 'delivery_provider_id', 'tracking_number',
    'customer_name', 'phone', 'phone2', 'wilaya_code', 'commune', 'address', 'delivery_type',
    'customer_notes', 'delivery_fee', 'discount', 'total_amount', 'needs_review', 'awaiting_assignment'];
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, actor_id, actor_label, event_type, new_value, metadata)
    values (new.id, v_actor, v_label, 'created', new.source,
            jsonb_build_object('external_id', new.external_id, 'source_id', new.source_id));
    return null;
  end if;

  foreach v_field in array v_fields loop
    if v_old -> v_field is distinct from v_new -> v_field then
      v_type := case v_field
        when 'confirmation_status' then 'status_change'
        when 'assigned_to' then 'assignment'
        when 'delivery_status' then 'delivery_status'
        when 'tracking_number' then 'delivery_update'
        when 'delivery_provider_id' then 'delivery_update'
        when 'needs_review' then 'review_flag'
        when 'awaiting_assignment' then 'assignment_queue'
        else 'field_update' end;
      insert into public.order_events (order_id, actor_id, actor_label, event_type, field, old_value, new_value, note, metadata)
      values (new.id, v_actor, v_label, v_type, v_field, v_old ->> v_field, v_new ->> v_field, v_note,
              case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end);
    end if;
  end loop;
  return null;
end
$$;

create trigger orders_history after insert or update on public.orders
  for each row execute function public.tg_order_history();

-- Version bump for optimistic concurrency
create or replace function public.tg_order_version()
returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end
$$;

create trigger orders_version before update on public.orders
  for each row execute function public.tg_order_version();

-- ---------------------------------------------------------------------------
-- Notes (customer interactions)
-- ---------------------------------------------------------------------------
create table public.order_notes (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null default auth.uid(),
  body        text not null check (length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index order_notes_order_idx on public.order_notes (order_id, created_at);

create or replace function public.tg_order_note_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.order_events (order_id, actor_id, actor_label, event_type, new_value)
  values (new.order_id, coalesce(new.author_id, public.current_actor()), public.current_actor_label(), 'note_added', new.body);
  return null;
end
$$;

create trigger order_notes_event after insert on public.order_notes
  for each row execute function public.tg_order_note_event();

-- ---------------------------------------------------------------------------
-- Assignment history
-- ---------------------------------------------------------------------------
create table public.order_assignments (
  id                    bigint generated always as identity primary key,
  order_id              uuid not null references public.orders (id) on delete cascade,
  agent_id              uuid not null references public.profiles (id) on delete cascade,
  assigned_by           uuid references public.profiles (id) on delete set null,
  reason                text not null check (reason in ('auto', 'manual', 'redistribution', 'agent_unavailable', 'rebalance')),
  status_at_start       public.confirmation_status not null,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  status_at_end         public.confirmation_status,
  end_reason            text
);
create index order_assignments_order_idx on public.order_assignments (order_id, started_at);
create index order_assignments_agent_idx on public.order_assignments (agent_id, started_at desc);
create unique index order_assignments_open_uidx on public.order_assignments (order_id) where ended_at is null;

create table public.order_redistributions (
  id                 bigint generated always as identity primary key,
  order_id           uuid not null references public.orders (id) on delete cascade,
  from_agent_id      uuid references public.profiles (id) on delete set null,
  to_agent_id        uuid references public.profiles (id) on delete set null,
  status             public.confirmation_status not null,
  contact_attempts   integer not null,
  reason             text not null,
  notes_snapshot     jsonb not null default '[]',
  created_at         timestamptz not null default now()
);
create index order_redistributions_order_idx on public.order_redistributions (order_id, created_at);

-- Duplicate detection: same normalised phone within the last 7 days.
create or replace function public.tg_order_detect_duplicate()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.phone_normalized is not null then
    select o.id into new.possible_duplicate_of
    from public.orders o
    where o.phone_normalized = new.phone_normalized
      and o.id <> new.id
      and o.ordered_at > new.ordered_at - interval '7 days'
      and o.confirmation_status not in ('cancelled', 'duplicate')
    order by o.ordered_at desc
    limit 1;
  end if;
  return new;
end
$$;

create trigger orders_detect_duplicate before insert on public.orders
  for each row execute function public.tg_order_detect_duplicate();
