-- Stock held by the delivery company (e.g. ECOTRACK fulfilment), per product.
-- Read-only mirror: written by the sync job (service role), never edited by hand.
create table public.product_provider_stock (
  product_id   uuid not null references public.products (id) on delete cascade,
  provider_id  uuid not null references public.delivery_providers (id) on delete cascade,
  physical     integer not null default 0,
  reserved     integer not null default 0,
  available    integer not null default 0,
  synced_at    timestamptz not null default now(),
  primary key (product_id, provider_id)
);
alter table public.product_provider_stock enable row level security;
create policy product_provider_stock_select on public.product_provider_stock for select to authenticated using (public.is_active_user());
grant select on public.product_provider_stock to authenticated;

alter table public.delivery_providers add column if not exists stock_synced_at timestamptz;
