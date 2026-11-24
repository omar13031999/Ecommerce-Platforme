-- =============================================================================
-- 0012 — Sync role/activation from auth app_metadata on UPDATE.
--
-- Supabase Auth (GoTrue) inserts the auth.users row first and writes
-- app_metadata in a subsequent UPDATE, so the insert trigger alone cannot see
-- the role. app_metadata is only writable with the service role (never by the
-- user), so mirroring it is safe. Only fields that actually changed in
-- app_metadata are applied, so profile edits made through
-- update_staff_member() are never overwritten by unrelated auth updates.
-- =============================================================================
create or replace function public.handle_auth_user_metadata_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role;
begin
  if (new.raw_app_meta_data ->> 'role') is distinct from (old.raw_app_meta_data ->> 'role')
     and (new.raw_app_meta_data ->> 'role') in ('admin', 'manager', 'agent') then
    v_role := (new.raw_app_meta_data ->> 'role')::public.app_role;
    update public.profiles
       set role = v_role,
           is_active = coalesce((new.raw_app_meta_data ->> 'active')::boolean, true)
     where id = new.id;
  elsif (new.raw_app_meta_data ->> 'active') is distinct from (old.raw_app_meta_data ->> 'active')
        and (new.raw_app_meta_data ->> 'active') in ('true', 'false') then
    update public.profiles set is_active = (new.raw_app_meta_data ->> 'active')::boolean where id = new.id;
  end if;

  if (new.raw_user_meta_data ->> 'full_name') is distinct from (old.raw_user_meta_data ->> 'full_name')
     and coalesce(new.raw_user_meta_data ->> 'full_name', '') <> '' then
    update public.profiles set full_name = new.raw_user_meta_data ->> 'full_name' where id = new.id and full_name = split_part(coalesce(new.email, ''), '@', 1);
  end if;
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end
$$;

create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.handle_auth_user_metadata_update();

revoke execute on function public.handle_auth_user_metadata_update() from public, anon, authenticated;
