-- =============================================================================
-- 0005 — Delivery: shipments (idempotent submission), events, webhooks, mapping
-- =============================================================================

create table public.delivery_shipments (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders (id) on delete cascade,
  provider_id           uuid not null references public.delivery_providers (id),
  idempotency_key       text not null unique,
  status                text not null default 'submitting'
                        check (status in ('submitting', 'submitted', 'failed', 'unknown', 'cancelled')),
  is_active             boolean not null default true,
  attempt_count         integer not null default 0,
  provider_shipment_id  text,
  tracking_number       text,
  provider_reference    text,
  provider_status       text,
  label_url             text,
  request_payload       jsonb,
  response_payload      jsonb,   -- raw provider response (may contain fees: restricted)
  error_code            text,
  error_message         text,
  submitted_at          timestamptz,
  last_synced_at        timestamptz,
  sync_error_count      integer not null default 0,
  last_sync_error       text,
  created_by            uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index delivery_shipments_active_uidx on public.delivery_shipments (order_id) where is_active;
create index delivery_shipments_tracking_idx on public.delivery_shipments (provider_id, tracking_number);
create index delivery_shipments_status_idx on public.delivery_shipments (status, last_synced_at);

create trigger delivery_shipments_updated_at before update on public.delivery_shipments
  for each row execute function public.tg_set_updated_at();

create table public.delivery_events (
  id               bigint generated always as identity primary key,
  shipment_id      uuid references public.delivery_shipments (id) on delete cascade,
  order_id         uuid not null references public.orders (id) on delete cascade,
  provider_id      uuid references public.delivery_providers (id) on delete set null,
  source           text not null check (source in ('webhook', 'poll', 'manual', 'system', 'import')),
  provider_status  text,
  internal_status  public.delivery_status,
  occurred_at      timestamptz not null default now(),
  payload          jsonb,
  dedupe_key       text not null unique,
  applied          boolean not null default false,
  created_at       timestamptz not null default now()
);
create index delivery_events_order_idx on public.delivery_events (order_id, occurred_at);

-- Provider status -> internal status overrides (adapters also ship defaults).
create table public.delivery_status_mappings (
  id               uuid primary key default gen_random_uuid(),
  provider_id      uuid not null references public.delivery_providers (id) on delete cascade,
  provider_status  text not null,
  internal_status  public.delivery_status not null,
  unique (provider_id, provider_status)
);

-- Raw inbound webhooks (kept for traceability / replay).
create table public.webhook_inbox (
  id               bigint generated always as identity primary key,
  provider_id      uuid references public.delivery_providers (id) on delete set null,
  received_at      timestamptz not null default now(),
  headers          jsonb,
  body             text,
  signature_valid  boolean,
  processed_at     timestamptz,
  result           jsonb,
  error            text
);
create index webhook_inbox_provider_idx on public.webhook_inbox (provider_id, received_at desc);

-- Ordering of internal statuses (used to refuse obviously stale regressions)
create or replace function public.delivery_status_rank(p public.delivery_status)
returns integer language sql immutable as $$
  select case p
    when 'not_submitted' then 0 when 'pending_submission' then 1 when 'submission_failed' then 1
    when 'submitted' then 2 when 'processing' then 3 when 'ready_for_pickup' then 4
    when 'picked_up' then 5 when 'in_transit' then 6 when 'out_for_delivery' then 7
    when 'failed_delivery' then 7 when 'distributed' then 8 when 'delivered' then 9
    when 'returned' then 9 when 'cancelled' then 9 end
$$;

-- ---------------------------------------------------------------------------
-- Submission state machine (called by trusted server code / service role)
-- ---------------------------------------------------------------------------

-- Step 1: claim. Validates eligibility and creates (or reuses) the shipment row
-- with a stable idempotency key. Refuses while a previous attempt is unresolved.
create or replace function public.claim_shipment_submission(p_order_id uuid, p_provider_id uuid, p_actor uuid default null)
returns public.delivery_shipments
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  sh public.delivery_shipments;
  v_attempt integer;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if o.confirmation_status <> 'confirmed' then
    raise exception 'order_not_confirmed' using errcode = '22023';
  end if;
  if o.delivery_status not in ('not_submitted', 'submission_failed', 'pending_submission') then
    raise exception 'order_already_submitted' using errcode = '22023';
  end if;

  select * into sh from public.delivery_shipments where order_id = p_order_id and is_active for update;
  if found then
    if sh.status = 'submitted' then
      raise exception 'order_already_submitted' using errcode = '22023';
    elsif sh.status = 'submitting' and sh.updated_at > now() - interval '2 minutes' then
      raise exception 'submission_in_progress' using errcode = '55P03';
    elsif sh.status in ('unknown', 'submitting') then
      -- Ambiguous previous attempt: caller must reconcile with the provider first.
      update public.delivery_shipments set status = 'unknown' where id = sh.id returning * into sh;
      return sh;
    elsif sh.provider_id <> p_provider_id or sh.status = 'failed' then
      update public.delivery_shipments set is_active = false,
        status = case when status = 'failed' then 'failed' else 'cancelled' end
      where id = sh.id;
    end if;
  end if;

  select count(*) + 1 into v_attempt from public.delivery_shipments where order_id = p_order_id;
  insert into public.delivery_shipments (order_id, provider_id, idempotency_key, status, attempt_count, created_by)
  values (p_order_id, p_provider_id, 'ORD' || o.reference || '-' || v_attempt, 'submitting', 1, p_actor)
  returning * into sh;

  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  update public.orders set delivery_status = 'pending_submission', delivery_status_at = now(),
         delivery_provider_id = p_provider_id
   where id = p_order_id;
  return sh;
end
$$;

-- Step 2a: success
create or replace function public.complete_shipment_submission(
  p_shipment_id uuid, p_tracking text, p_provider_shipment_id text, p_provider_reference text,
  p_label_url text, p_request jsonb, p_response jsonb, p_actor uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  sh public.delivery_shipments;
begin
  update public.delivery_shipments set
    status = 'submitted', tracking_number = p_tracking, provider_shipment_id = p_provider_shipment_id,
    provider_reference = p_provider_reference, label_url = p_label_url,
    request_payload = coalesce(p_request, request_payload), response_payload = p_response,
    submitted_at = now(), last_synced_at = now(), error_code = null, error_message = null
  where id = p_shipment_id
  returning * into sh;

  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  update public.orders set
    delivery_status = 'submitted', delivery_status_at = now(), submitted_at = now(),
    tracking_number = p_tracking, delivery_provider_id = sh.provider_id
  where id = sh.order_id;

  insert into public.delivery_events (shipment_id, order_id, provider_id, source, provider_status, internal_status, payload, dedupe_key, applied)
  values (sh.id, sh.order_id, sh.provider_id, 'system', 'created', 'submitted', p_response, 'submit:' || sh.id, true)
  on conflict (dedupe_key) do nothing;
end
$$;

-- Step 2b: definitive failure (validation / rejected) or ambiguous outcome
create or replace function public.fail_shipment_submission(
  p_shipment_id uuid, p_ambiguous boolean, p_error_code text, p_error_message text,
  p_request jsonb, p_response jsonb, p_actor uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  sh public.delivery_shipments;
begin
  update public.delivery_shipments set
    status = case when p_ambiguous then 'unknown' else 'failed' end,
    is_active = p_ambiguous,
    error_code = p_error_code, error_message = left(p_error_message, 2000),
    request_payload = coalesce(p_request, request_payload), response_payload = p_response
  where id = p_shipment_id
  returning * into sh;

  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  perform set_config('app.event_note', left(coalesce(p_error_message, ''), 500), true);
  update public.orders set
    delivery_status = (case when p_ambiguous then 'pending_submission' else 'submission_failed' end)::public.delivery_status,
    delivery_status_at = now()
  where id = sh.order_id;
  perform set_config('app.event_note', '', true);

  if p_ambiguous then
    perform public.notify_permission('delivery.manage', 'shipment_unknown',
      jsonb_build_object('order_id', sh.order_id), '/delivery');
  end if;
end
$$;

-- Apply one tracking event idempotently. Returns true when the order changed.
create or replace function public.apply_delivery_event(
  p_order_id uuid, p_shipment_id uuid, p_provider_id uuid, p_source text,
  p_provider_status text, p_internal_status public.delivery_status, p_occurred_at timestamptz,
  p_payload jsonb, p_dedupe_key text
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_event_id bigint;
  o public.orders;
  v_apply boolean;
begin
  insert into public.delivery_events (shipment_id, order_id, provider_id, source, provider_status, internal_status, occurred_at, payload, dedupe_key)
  values (p_shipment_id, p_order_id, p_provider_id, p_source, p_provider_status, p_internal_status,
          coalesce(p_occurred_at, now()), p_payload, p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false; -- duplicate delivery of the same event
  end if;

  if p_shipment_id is not null then
    update public.delivery_shipments
       set provider_status = p_provider_status, last_synced_at = now(), sync_error_count = 0, last_sync_error = null
     where id = p_shipment_id;
  end if;

  if p_internal_status is null then
    return false; -- unmapped provider status: stored for review, order untouched
  end if;

  select * into o from public.orders where id = p_order_id for update;
  -- Out-of-order protection: ignore events older than the current status, and
  -- never move a final state backwards unless the event is newer.
  v_apply := o.delivery_status is distinct from p_internal_status
    and (o.delivery_status_at is null or coalesce(p_occurred_at, now()) >= o.delivery_status_at
         or public.delivery_status_rank(p_internal_status) > public.delivery_status_rank(o.delivery_status));

  if v_apply then
    perform set_config('app.actor_label', p_source, true);
    update public.orders set
      delivery_status = p_internal_status,
      delivery_status_at = greatest(coalesce(p_occurred_at, now()), coalesce(delivery_status_at, '-infinity'::timestamptz)),
      delivered_at = case when p_internal_status in ('distributed', 'delivered') then coalesce(delivered_at, p_occurred_at, now()) else delivered_at end,
      returned_at = case when p_internal_status = 'returned' then coalesce(p_occurred_at, now()) else returned_at end
    where id = p_order_id;
    update public.delivery_events set applied = true where id = v_event_id;
  end if;
  return v_apply;
end
$$;

-- Manual delivery status update by delivery managers (providers without API).
create or replace function public.set_delivery_status_manual(
  p_order_id uuid, p_status public.delivery_status, p_tracking text default null,
  p_provider_id uuid default null, p_note text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
begin
  if not public.has_permission('delivery.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if o.confirmation_status <> 'confirmed' and p_status not in ('not_submitted', 'cancelled') then
    raise exception 'order_not_confirmed' using errcode = '22023';
  end if;
  perform set_config('app.event_note', coalesce(p_note, ''), true);
  update public.orders set
    delivery_status = p_status,
    delivery_status_at = now(),
    tracking_number = coalesce(nullif(btrim(p_tracking), ''), tracking_number),
    delivery_provider_id = coalesce(p_provider_id, delivery_provider_id),
    submitted_at = case when p_status = 'submitted' then coalesce(submitted_at, now()) else submitted_at end,
    delivered_at = case when p_status in ('distributed', 'delivered') then coalesce(delivered_at, now()) else delivered_at end,
    returned_at = case when p_status = 'returned' then now() else returned_at end
  where id = p_order_id;
  perform set_config('app.event_note', '', true);

  insert into public.delivery_events (order_id, provider_id, source, provider_status, internal_status, payload, dedupe_key, applied)
  values (p_order_id, coalesce(p_provider_id, o.delivery_provider_id), 'manual', p_status::text, p_status,
          jsonb_build_object('note', p_note, 'by', auth.uid()), 'manual:' || gen_random_uuid(), true);
end
$$;

-- Directory of providers that any staff member may see (name only).
create view public.delivery_provider_directory
with (security_invoker = false) as
  select id, name, code, tracking_url_template from public.delivery_providers;
