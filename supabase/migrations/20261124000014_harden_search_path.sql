-- =============================================================================
-- 0014 — Pin search_path on helper/trigger functions (Supabase advisor 0011).
-- =============================================================================
alter function public.tg_set_updated_at() set search_path = '';
alter function public.next_recurrence(date, text, integer) set search_path = '';
alter function public.tg_order_version() set search_path = '';
alter function public.lock_assignment_engine() set search_path = '';
alter function public.tg_settlement_status() set search_path = '';
alter function public.local_date(timestamptz) set search_path = '';
alter function public.normalize_text(text) set search_path = '';
alter function public.normalize_phone(text) set search_path = '';
alter function public.na_level(public.confirmation_status) set search_path = '';
alter function public.delivery_status_rank(public.delivery_status) set search_path = '';
alter function public.role_default_permissions(public.app_role) set search_path = '';
alter function public.all_permissions() set search_path = '';
alter function public.sensitive_permissions() set search_path = '';
