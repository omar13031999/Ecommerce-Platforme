-- =============================================================================
-- 0002 — Reference data & catalog: wilayas, products, costs, matching
-- =============================================================================

create table public.wilayas (
  code     smallint primary key check (code between 1 and 99),
  name_fr  text not null,
  name_ar  text not null
);

insert into public.wilayas (code, name_fr, name_ar) values
 (1,'Adrar','أدرار'),(2,'Chlef','الشلف'),(3,'Laghouat','الأغواط'),(4,'Oum El Bouaghi','أم البواقي'),
 (5,'Batna','باتنة'),(6,'Béjaïa','بجاية'),(7,'Biskra','بسكرة'),(8,'Béchar','بشار'),
 (9,'Blida','البليدة'),(10,'Bouira','البويرة'),(11,'Tamanrasset','تمنراست'),(12,'Tébessa','تبسة'),
 (13,'Tlemcen','تلمسان'),(14,'Tiaret','تيارت'),(15,'Tizi Ouzou','تيزي وزو'),(16,'Alger','الجزائر'),
 (17,'Djelfa','الجلفة'),(18,'Jijel','جيجل'),(19,'Sétif','سطيف'),(20,'Saïda','سعيدة'),
 (21,'Skikda','سكيكدة'),(22,'Sidi Bel Abbès','سيدي بلعباس'),(23,'Annaba','عنابة'),(24,'Guelma','قالمة'),
 (25,'Constantine','قسنطينة'),(26,'Médéa','المدية'),(27,'Mostaganem','مستغانم'),(28,'M''Sila','المسيلة'),
 (29,'Mascara','معسكر'),(30,'Ouargla','ورقلة'),(31,'Oran','وهران'),(32,'El Bayadh','البيض'),
 (33,'Illizi','إليزي'),(34,'Bordj Bou Arréridj','برج بوعريريج'),(35,'Boumerdès','بومرداس'),(36,'El Tarf','الطارف'),
 (37,'Tindouf','تندوف'),(38,'Tissemsilt','تيسمسيلت'),(39,'El Oued','الوادي'),(40,'Khenchela','خنشلة'),
 (41,'Souk Ahras','سوق أهراس'),(42,'Tipaza','تيبازة'),(43,'Mila','ميلة'),(44,'Aïn Defla','عين الدفلى'),
 (45,'Naâma','النعامة'),(46,'Aïn Témouchent','عين تموشنت'),(47,'Ghardaïa','غرداية'),(48,'Relizane','غليزان'),
 (49,'Timimoun','تيميمون'),(50,'Bordj Badji Mokhtar','برج باجي مختار'),(51,'Ouled Djellal','أولاد جلال'),
 (52,'Béni Abbès','بني عباس'),(53,'In Salah','عين صالح'),(54,'In Guezzam','عين قزام'),(55,'Touggourt','تقرت'),
 (56,'Djanet','جانت'),(57,'El M''Ghair','المغير'),(58,'El Meniaa','المنيعة');

-- Text normalisation used for matching (lower, unaccented-ish, collapsed spaces)
create or replace function public.normalize_text(p text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(lower(translate(coalesce(p, ''),
    'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÇçÑñ''’',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn  ')), '\s+', ' ', 'g')), '')
$$;

-- Algerian phone normalisation: keep digits, map +213/00213 to leading 0.
create or replace function public.normalize_phone(p text)
returns text language sql immutable as $$
  select case
    when d is null or d = '' then null
    when d like '00213%' then '0' || substr(d, 6)
    when d like '213%' and length(d) >= 12 then '0' || substr(d, 4)
    when length(d) = 9 and d !~ '^0' then '0' || d
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s
$$;

-- Resolve a wilaya code from free text ("16", "16 - Alger", "Alger", "الجزائر")
create or replace function public.resolve_wilaya(p text)
returns smallint
language sql stable set search_path = ''
as $$
  with input as (select btrim(coalesce(p, '')) as raw)
  select coalesce(
    (select w.code from public.wilayas w, input
      where (input.raw ~ '^\d{1,2}' and w.code = (substring(input.raw from '^(\d{1,2})'))::smallint)
      limit 1),
    (select w.code from public.wilayas w, input
      where public.normalize_text(w.name_fr) = public.normalize_text(regexp_replace(input.raw, '^\d+\s*[-–.]?\s*', ''))
         or w.name_ar = btrim(regexp_replace(input.raw, '^\d+\s*[-–.]?\s*', ''))
      limit 1)
  )
$$;

-- ---------------------------------------------------------------------------
-- Products. Selling data is visible to staff; costs live in product_costs.
-- ---------------------------------------------------------------------------
create table public.products (
  id             uuid primary key default gen_random_uuid(),
  sku            text,
  name           text not null,
  description    text,
  selling_price  numeric(12, 2) not null default 0 check (selling_price >= 0),
  is_archived    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.profiles (id) on delete set null
);
create unique index products_sku_uidx on public.products (lower(sku)) where sku is not null and sku <> '';
create index products_name_idx on public.products (public.normalize_text(name));

create trigger products_updated_at before update on public.products
  for each row execute function public.tg_set_updated_at();
create trigger products_audit after insert or update or delete on public.products
  for each row execute function public.tg_audit_row();

-- CONFIDENTIAL: purchase cost and per-unit operational overrides.
create table public.product_costs (
  product_id       uuid primary key references public.products (id) on delete cascade,
  purchase_cost    numeric(12, 2) check (purchase_cost is null or purchase_cost >= 0), -- null = unknown (never assumed 0)
  packaging_cost   numeric(12, 2) check (packaging_cost is null or packaging_cost >= 0), -- null = use global default
  storage_cost     numeric(12, 2) check (storage_cost is null or storage_cost >= 0),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles (id) on delete set null
);

create table public.product_cost_history (
  id             bigint generated always as identity primary key,
  product_id     uuid not null references public.products (id) on delete cascade,
  old_cost       numeric(12, 2),
  new_cost       numeric(12, 2),
  changed_by     uuid references public.profiles (id) on delete set null,
  changed_at     timestamptz not null default now()
);

create or replace function public.tg_product_cost_history()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(public.current_actor(), new.updated_by);
  if tg_op = 'INSERT' or old.purchase_cost is distinct from new.purchase_cost then
    insert into public.product_cost_history (product_id, old_cost, new_cost, changed_by)
    values (new.product_id, case when tg_op = 'UPDATE' then old.purchase_cost end, new.purchase_cost, public.current_actor());
  end if;
  return new;
end
$$;

create trigger product_costs_history before insert or update on public.product_costs
  for each row execute function public.tg_product_cost_history();

-- Every product gets a (possibly empty) cost row so "missing cost" is explicit.
create or replace function public.tg_product_init_cost()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.product_costs (product_id) values (new.id) on conflict do nothing;
  return new;
end
$$;

create trigger products_init_cost after insert on public.products
  for each row execute function public.tg_product_init_cost();

-- Matching rules: alias text (as seen in sheets / sources) -> product
create table public.product_aliases (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products (id) on delete cascade,
  alias             text not null,
  alias_normalized  text generated always as (public.normalize_text(alias)) stored,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now()
);
create unique index product_aliases_uidx on public.product_aliases (alias_normalized);

-- Match order lines to products: SKU, then alias, then exact normalized name.
create or replace function public.match_product(p_sku text, p_name text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.id from public.products p
      where p_sku is not null and btrim(p_sku) <> '' and lower(p.sku) = lower(btrim(p_sku)) and not p.is_archived
      limit 1),
    (select a.product_id from public.product_aliases a
      join public.products p on p.id = a.product_id and not p.is_archived
      where a.alias_normalized = public.normalize_text(coalesce(nullif(btrim(p_sku), ''), p_name))
         or a.alias_normalized = public.normalize_text(p_name)
      limit 1),
    (select p.id from public.products p
      where public.normalize_text(p.name) = public.normalize_text(p_name) and not p.is_archived
      order by p.created_at
      limit 1)
  )
$$;

-- ---------------------------------------------------------------------------
-- Delivery providers (declared here because orders reference them)
-- ---------------------------------------------------------------------------
create table public.delivery_providers (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null check (code ~ '^[a-z0-9_]+$'), -- adapter key: yalidine, ecotrack, manual
  name                      text not null,
  is_active                 boolean not null default true,
  base_url                  text,
  config                    jsonb not null default '{}', -- non-secret adapter config
  webhook_enabled           boolean not null default false,
  webhook_token             text not null default encode(gen_random_bytes(24), 'hex'), -- path token for our endpoint
  polling_enabled           boolean not null default true,
  polling_interval_minutes  integer not null default 60 check (polling_interval_minutes between 5 and 1440),
  tracking_url_template     text, -- e.g. https://example/track/{tracking}
  last_polled_at            timestamptz,
  credentials_configured    boolean not null default false,
  last_test_at              timestamptz,
  last_test_ok              boolean,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create trigger delivery_providers_updated_at before update on public.delivery_providers
  for each row execute function public.tg_set_updated_at();
create trigger delivery_providers_audit after insert or update or delete on public.delivery_providers
  for each row execute function public.tg_audit_row();

-- Provider tariffs (CONFIDENTIAL): used to estimate actual delivery cost when the
-- provider has not reported a real charge yet.
create table public.delivery_rates (
  provider_id     uuid not null references public.delivery_providers (id) on delete cascade,
  wilaya_code     smallint not null references public.wilayas (code),
  home_cost       numeric(12, 2),
  stopdesk_cost   numeric(12, 2),
  return_cost     numeric(12, 2),
  updated_at      timestamptz not null default now(),
  primary key (provider_id, wilaya_code)
);
