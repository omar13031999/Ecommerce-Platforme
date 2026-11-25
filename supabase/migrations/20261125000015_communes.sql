-- Communes reference list (per wilaya), imported from the delivery provider so
-- names match its spelling exactly (ECOTRACK rejects unknown commune names).
create table public.communes (
  id             bigint generated always as identity primary key,
  wilaya_code    smallint not null references public.wilayas (code),
  name           text not null,
  postal_code    text,
  has_stop_desk  boolean not null default false,
  is_active      boolean not null default true,
  source         text not null default 'manual',
  updated_at     timestamptz not null default now()
);
create unique index communes_wilaya_name_uidx on public.communes (wilaya_code, lower(name));
create index communes_wilaya_idx on public.communes (wilaya_code) where is_active;

alter table public.communes enable row level security;
create policy communes_select on public.communes for select to authenticated using (true);
create policy communes_write on public.communes for all to authenticated
  using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));
grant select on public.communes to authenticated;
revoke insert, update, delete on public.communes from anon;
