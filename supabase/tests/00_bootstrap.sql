-- Minimal emulation of the Supabase environment for local tests (NOT a migration).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_app_meta_data jsonb default '{}',
  raw_user_meta_data jsonb default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------- test helpers
create schema tests;
grant usage on schema tests to authenticated, anon;
create function tests.create_user(p_email text, p_role text, p_active boolean default true, p_cap int default 30)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
  values (p_email, jsonb_build_object('role', p_role, 'active', p_active), jsonb_build_object('full_name', p_email))
  returning id into v;
  update public.profiles set max_active_orders = p_cap where id = v;
  return v;
end $$;
create function tests.login(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false)
$$;
create function tests.assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'ASSERTION FAILED: %', p_msg; end if;
end $$;
create function tests.new_order(p_name text default 'Client', p_phone text default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.orders (customer_name, phone, wilaya_code, address)
  values (p_name, coalesce(p_phone, '05' || lpad((floor(random()*100000000))::int::text, 8, '0')), 16, 'Rue test')
  returning id into v;
  insert into public.order_items (order_id, product_name, quantity, unit_price) values (v, 'Produit X', 1, 2500);
  return v;
end $$;
grant execute on all functions in schema tests to authenticated;
