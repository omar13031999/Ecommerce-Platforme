-- =============================================================================
-- 0011 — Private storage bucket for expense invoices/attachments.
-- No storage policies are created: objects are only reachable through the
-- server (service role) after a finance permission check, via short-lived
-- signed URLs.
-- =============================================================================
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('expense-attachments', 'expense-attachments', false, 5242880,
            array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end
$$;
