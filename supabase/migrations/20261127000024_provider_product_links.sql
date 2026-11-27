-- Which product of a delivery company's store corresponds to each catalogue
-- product (Maystro orders must reference the store's own product ids).
create table public.product_provider_links (
  product_id    uuid not null references public.products (id) on delete cascade,
  provider_id   uuid not null references public.delivery_providers (id) on delete cascade,
  external_id   text not null,
  external_name text,
  updated_at    timestamptz not null default now(),
  primary key (product_id, provider_id)
);
alter table public.product_provider_links enable row level security;
create policy product_provider_links_select on public.product_provider_links for select to authenticated using (public.is_active_user());
create policy product_provider_links_write on public.product_provider_links for all to authenticated
  using (public.has_permission('products.manage') or public.has_permission('delivery.manage'))
  with check (public.has_permission('products.manage') or public.has_permission('delivery.manage'));
grant select, insert, update, delete on public.product_provider_links to authenticated;
