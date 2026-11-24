-- =============================================================================
-- 0010 — Function privileges (allow-list)
--
-- Supabase grants EXECUTE on new functions to anon/authenticated by default.
-- Internal engine functions (assignment, delivery state machine, imports, job
-- leases, settings readers…) must only be callable by trusted server code
-- (service role), so we revoke everything and re-grant an explicit allow-list.
-- Every allow-listed RPC re-checks permissions internally.
-- =============================================================================
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;

grant execute on function
  -- used by RLS policies / views
  public.has_permission(text),
  public.current_role_name(),
  public.is_active_user(),
  public.can_view_order(uuid),
  public.local_date(timestamptz),
  public.workload_statuses(),
  public.normalize_text(text),
  public.normalize_phone(text),
  public.na_level(public.confirmation_status),
  public.delivery_status_rank(public.delivery_status),
  public.role_default_permissions(public.app_role),
  public.all_permissions(),
  public.sensitive_permissions(),
  -- workflow RPCs
  public.set_confirmation_status(uuid, public.confirmation_status, text, integer),
  public.manual_assign_orders(uuid[], uuid, boolean, text),
  public.auto_assign_orders(uuid[]),
  public.unassign_orders(uuid[]),
  public.resolve_review(uuid, text),
  public.update_staff_member(uuid, jsonb),
  public.set_delivery_status_manual(uuid, public.delivery_status, text, uuid, text),
  public.create_order(jsonb),
  public.update_order_customer(uuid, jsonb, integer),
  public.match_order_item(uuid, uuid, boolean),
  public.recalculate_item_costs(uuid, date, date),
  public.mark_notifications_read(bigint[]),
  public.set_my_locale(public.app_locale),
  -- reporting (each checks permissions or relies on RLS)
  public.dashboard_operational(date, date, uuid),
  public.orders_timeseries(date, date),
  public.agent_performance(date, date),
  public.product_operational_stats(date, date),
  public.financial_summary(date, date),
  public.profit_timeseries(date, date),
  public.product_financial_stats(date, date)
to authenticated;
